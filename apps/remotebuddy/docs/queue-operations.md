# RemoteBuddy queue operations

This reference describes the normal operator-visible transitions around RemoteBuddy. Server is the queue authority; RemoteBuddy is a fenced request consumer and job producer.

## Normal request lifecycle

| Stage           | Durable evidence                                                                                                    | Owner                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Accepted        | Request row is `pending`; session emits the user's `message` event.                                                 | Server                              |
| Planning        | Request is `claimed` with `agentId`, `claimToken`, `claimGeneration`, and lease timestamps.                         | RemoteBuddy                         |
| Direct response | Assistant event is emitted and request becomes `completed` with `workerRequired=0`.                                 | RemoteBuddy through Server          |
| Worker handoff  | A durable job exists; request records `workerRequired=1` and the exact `handoffJobId`.                              | RemoteBuddy through Server          |
| Execution       | Job is `claimed`; `/jobs/:id/start`, heartbeats, logs, and tool runs prove activity.                                | WorkerPal through Server            |
| Publication     | Job is `finalizing` and a completion is pending or claimed.                                                         | SourceControlManager through Server |
| Terminal        | Job becomes `completed`, `failed`, `abandoned`, or `publish_blocked`; request `outcomeStatus` projects that result. | Server                              |

Session task events are useful UI breadcrumbs, but the queue rows are authoritative. In particular, `task_created` is emitted after a durable job enqueue and should not be used as the proof that a job exists.

## Priority and work class

Requests have three priorities: `interactive`, `normal`, and `background`.

Jobs carry both a priority and a work class. Work classes include `interactive`, `standard`, `autonomy`, `background`, plus capability-controlled `recovery` and `repair`. Queue-deadline misses and elevated recovery work can rank ahead of ordinary priority order. Operators should use the returned `jobPendingSnapshot` order rather than recreating the scheduler with a simple sort.

RemoteBuddy does not maintain independent queues or worker pools for these lanes. Any compatible online WorkerPal can claim from Server's job queue, subject to target-worker and runtime constraints.

## Worker capacity

RemoteBuddy's autoscaler reads `GET /workers/autoscale` at the configured request poll interval. With auto-spawn enabled, its target is bounded by `min_workerpals` and `max_workerpals` and considers:

- Current online and busy workers.
- Autoscalable pending `task.execute` jobs.
- A small floor while persisted WorkerPal PRs remain open and unmerged.

It spawns workers one at a time and waits for a Server heartbeat before considering startup healthy. A startup failure enters a cooldown based on `crash_restart_backoff_ms`.

If a Docker WorkerPal exits with the dedicated Codex-startup-stall code, RemoteBuddy can switch future spawns to direct isolated-worktree execution. Set `REMOTEBUDDY_DISABLE_WORKERPAL_DIRECT_FALLBACK=1` only when an installation must prohibit that fallback.

## Supported operator actions

| Need                        | Supported action                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Inspect queue and capacity  | Client observability views or `GET /system/status`.                                                               |
| Inspect one request         | `GET /requests/:id`.                                                                                              |
| Inspect a job               | `GET /jobs`, then its logs, tool runs, and diagnostics endpoints.                                                 |
| Add manual worker capacity  | `bun run workerpals:only` or `bun run workerpals:only:docker`.                                                    |
| Restart RemoteBuddy only    | Stop the process cleanly and run `bun run remotebuddy:only`.                                                      |
| Restart with full preflight | `bun run start`.                                                                                                  |
| Toggle autonomy at runtime  | Change `remotebuddy.autonomy.enabled` through the supported runtime-config surface; RemoteBuddy polls that field. |

There is no supported operator action to "force complete," rewrite a lease, replay a publication webhook, drain a worker with `--drain`, or throttle background jobs through LocalBuddy.

## Idempotency and retry rules

- RemoteBuddy derives a stable job dedupe key from session, request, and targeted scope. A retry reuses the exact payload.
- Active matching work can return the existing job with `deduped=true`; RemoteBuddy emits progress against that task instead of creating a duplicate.
- Enqueue and request lifecycle calls have bounded retries. Ambiguous outcomes are reconciled from durable state.
- A request with a durable worker handoff is not failed merely because the handoff callback response was lost.
- Expired request or job claims are recovered by Server, with fencing tokens preventing stale owners from mutating reclaimed rows.

## Escalating a failure

Escalate by subsystem, using evidence from the durable stage:

- Planning/claim failure: RemoteBuddy logs plus the request row.
- Execution/worker lease failure: WorkerPal logs, job logs, tool runs, and diagnostics.
- Finalization/publication failure: completion row, publication summary, candidate ref, and SourceControlManager logs.
- Repository analysis failure: `queues.repositoryAgentHealth` and `[RepositoryAgent]` logs.
- Autonomous dispatch failure: `/autonomy/insights`, `/autonomy/safety`, the request's autonomy metadata, and `[Autonomy]` logs.

External team names, paging rotations, and chat channels are deployment-specific and are intentionally not asserted here.
