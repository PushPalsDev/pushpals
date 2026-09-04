# 06. RemoteBuddy (`apps/remotebuddy`)

## Purpose

RemoteBuddy is the planning and orchestration brain.

It owns:

- claiming queued requests,
- generating structured plans,
- deciding lane (`deterministic` vs `worker`),
- emitting assistant/task/job status events,
- enqueueing executable jobs for WorkerPals,
- maintaining durable planning memory for the repository,
- physically hosting the worker for the logical, cross-service RepositoryAgent capability.

It does not own:

- code execution (WorkerPals),
- git integration/PR merge policy (SourceControlManager),
- RepositoryAgent queue or shared-memory persistence (Server),
- authoritative validation or publication decisions.

The request handoff is `claimed request + planning context -> sanitized plan -> direct response or task.execute enqueue -> request completion/failure`. Claims are lease-bound and job enqueue uses a request-derived dedupe key, so callback uncertainty can be reconciled from durable Server state without dispatching duplicate work.

## Key Files

- `apps/remotebuddy/src/remotebuddy_main.ts` - orchestrator loop, planning, dispatch, and memory usage.
- `apps/remotebuddy/src/remotebuddy_supervisor.ts` - bounded restart and process-tree shutdown.
- `apps/remotebuddy/src/brain.ts` - planner contract + repair/fallback behavior.
- `apps/remotebuddy/src/command_policy.ts` and `path_targeting.ts` - validation and repository targeting.
- `apps/remotebuddy/src/memory.ts` - memory backend interface, noop/in-memory/composite backends.
- `apps/remotebuddy/src/persistent_memory.ts` - SQLite-backed persistent memory backend.
- `apps/remotebuddy/src/idempotency.ts` - legacy compatibility store; the
  current polling path constructs it but does not invoke it.
- `apps/remotebuddy/src/worker_spawn.ts` - managed WorkerPal launch commands.
- `apps/remotebuddy/src/autonomous_engine.ts` - bounded autonomous objective dispatch.
- `apps/remotebuddy/src/repository_agent.ts` - read-only RepositoryAgent worker, evidence checks, cache/fact use, and leased polling.

## Hosted RepositoryAgent Worker

RepositoryAgent is logically shared even though its worker currently lives in the RemoteBuddy process. Callers do not invoke RemoteBuddy directly. They use `RepositoryAgentClient` against Server, and Server brokers the durable request to whichever compatible worker holds the lease.

RemoteBuddy starts one bounded worker that:

1. claims from the dedicated RepositoryAgent queue,
2. heartbeats the fenced claim while it runs,
3. verifies stable repository identity plus the exact revision/content-tree snapshot,
4. checks an exact cache and recalls only still-valid evidence-backed facts,
5. gives RemoteBuddy's assigned LLM a bounded evidence packet; a first bounded model pass can select additional tracked files for the final analysis,
6. validates cited paths/blob hashes and verifies the snapshot again,
7. completes or fails through the lease-authority API.

The before/after snapshot fence catches repository drift and unintended writes. Repository content, recalled memory, and tool output are treated as untrusted evidence rather than instructions. Results and validation commands are proposals; the calling service's deterministic policy and validation gates remain authoritative.

RepositoryAgent availability must not deadlock RemoteBuddy's ordinary request
loop. The typed client applies bounded HTTP and overall polling deadlines. In
the normal RepositoryAgent-enabled autonomy path, an unavailable, timed-out,
malformed, or empty result leads directly to bounded deterministic repo/vision
candidates without a second model call. A composition with no RepositoryAgent
capability can still use the older bounded ideation path. Safety-critical
callers fail closed unless an existing deterministic path is independently
safe.

Codex-backed analysis never runs with the target repository as its working directory. It runs in a disposable neutral Git repository with project instructions, user rules, shell, apps, and web access disabled. HTTP completion backends receive the same evidence-only request and ignore the Codex execution hint.

See [RepositoryAgent and shared memory](https://github.com/PushPalsDev/pushpals/wiki/13-repository-agent-and-memory) for the cross-service contract.

## Session Planning Memory

RemoteBuddy retains a private modular memory backend for its existing session-planning context. This is distinct from the new cross-service memory API.

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

## Shared Repository Memory

RepositoryAgent does not write to RemoteBuddy's private `remotebuddy_memory` table. It uses `MemoryHttpClient` from `packages/shared` to call Server-owned memory endpoints. The shared store separates:

- exact analysis cache entries, keyed by repository snapshot, purpose/question, prompt version, and model,
- durable repository facts, scoped by stable repository identity and backed by path/blob evidence,
- reinforcement observations (`confirmed`, `successful`, `failed`, or `contradicted`) that adjust usefulness/confidence without erasing provenance.

Memory recall is advisory and bounded. Evidence blob IDs are rechecked against the requested worktree; stale records are invalidated. Services that adopt shared memory must use the typed interface rather than opening Server SQLite directly.

## What Session Planning Memory Remembers

RemoteBuddy persists high-signal orchestration facts, including:

- incoming request summary (`kind=request`),
- planner decision summary (`kind=plan`),
- job enqueue success/failure (`kind=job_enqueued`, `kind=job_enqueue_failed`),
- observed worker outcomes (`kind=job_completed`, `kind=job_failed`),
- planning failures (`kind=planning_failed`).

This history is scoped by repo root and session.

## How Session Planning Memory Is Used In Planning

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

Autonomous dispatch also reads the worker/publication snapshot. It pauses when
pending jobs already need workers or the completion/finalization backlog is old
or above publisher capacity. Once publication is healthy, a busy worker no
longer blocks ideation by itself when another online worker is safely idle.

Before scoring, autonomy removes candidates whose normalized targets overlap
open or recently completed objectives. The same exclusions are included in the
ideation prompt, so prompt variations cannot repeatedly spend scoring tokens on
one file or directory. On the compatibility path with no RepositoryAgent, a
timed-out legacy ideation request receives one compact retry with a 30-second
ceiling; a late RepositoryAgent failure does not start that retry.

Dispatch uses a durable fenced handoff: RemoteBuddy first persists a `gated`
objective, then enqueues an unclaimable provisional request with the
objective-derived idempotency key. Only the same still-live cycle can confirm
that request before its absolute snapshot/deadline expiry. The Server validates
the reservation and confirmation capability, makes the request claimable, and
owns the transition to `dispatched`. Unconfirmed rows expire durably and the
same idempotency key can be rearmed, so disable/deadline races cannot leak work
or suppress a later healthy cycle. Startup and periodic stale-claim
reconciliation link an already dispatched request or fail an orphaned
reservation, preventing queue/objective split-brain after interruption.

Every autonomy tick owns an abortable cycle generation. Scoring and planning
receive that signal and perform bounded provider draining on cancellation.
After each dispatch-lock renewal and objective reservation, at the provisional
enqueue response, and before confirmation, RemoteBuddy rechecks runtime
activity, the snapshot TTL, and the absolute cycle deadline. Both enqueue and
confirmation carry the cycle abort signal. Runtime configuration `enabled=false` is a
resumable scheduling pause; process disposal uses the separate terminal
`stop()` lifecycle and cannot be reversed on the same engine instance.
RemoteBuddy fails closed if a mixed-version Server omits the provisional or
already-confirmed attestation rather than trusting a bare request ID.

## Config Knobs

Primary knobs live in `configs/*.toml` under `[remotebuddy.memory]`:

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
- "RepositoryAgent is not answering":
  - inspect the Server-side request status/deadline and the hosted worker's lease renewal logs.
- "RepositoryAgent answer is stale":
  - compare requested identity/revision/tree, cited blob hashes, cache metadata, and memory references.

## Tradeoffs

Pros:

- durable repo-level context across sessions,
- backend modularity for future memory systems,
- bounded recall/summary size protects prompt budgets.

Cons:

- more state to reason about,
- risk of stale memory bias if retention is too long,
- extra storage/maintenance path (SQLite + pruning).
