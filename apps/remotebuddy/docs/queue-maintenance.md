# RemoteBuddy queue maintenance

PushPals queue maintenance is lifecycle reconciliation, not periodic manual database cleanup. Server owns the request, job, completion, RepositoryAgent, and autonomy tables in the shared SQLite database.

## Routine checks

Before and after upgrading or restarting the stack:

1. Keep the repository and runtime databases on persistent local storage.
2. Check `GET /healthz` and save a `GET /system/status` snapshot.
3. Note active request claims, claimed/finalizing jobs, pending completions, and retained publication candidates.
4. Stop services cleanly so WorkerPal and SourceControlManager processes can terminate their worktrees and claims.
5. Restart with `bun run start`, then confirm reconciliation state and queue movement.

Ordinary restart does not require clearing either database.

## State ownership

| State                                                                                             | Default path                        | Owner       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------- |
| Requests, jobs, logs, completions, workers, RepositoryAgent requests, autonomy, and shared memory | `outputs/data/pushpals.db`          | Server      |
| Optional RemoteBuddy planning memory plus initialized legacy cursor/handled-message tables        | `outputs/data/remotebuddy-state.db` | RemoteBuddy |

RemoteBuddy reads recent jobs from the shared database for planning context, but it does not own or mutate queue tables directly. All lifecycle writes go through Server's fenced HTTP routes.

`IdempotencyStore` is constructed against the RemoteBuddy database, but the current request-polling path does not call its cursor or handled-message methods. Active duplicate protection comes from Server request fencing and job dedupe; do not rely on the legacy tables for recovery.

## Automatic maintenance

The runtime performs these repairs during normal activity:

- Request claim expiry and request-to-job handoff reconciliation.
- Job stale-claim recovery with explicit retry-safety classification.
- Completion claim recovery and publication backlog reconciliation.
- Autonomous provisional-dispatch expiry and reservation reconciliation.
- RepositoryAgent deadline expiry, delayed retries, and stale-claim accounting.
- Expiry of old RemoteBuddy planning-memory records according to `remotebuddy.memory.retention_days`.

`GET /system/status`, list routes, heartbeats, and claim routes trigger relevant reconciliation paths. Inspect `runtime.reconciliation` and queue-specific health structures to see failures rather than editing rows around them.

## Avoid manual state mutation

Do not:

- Delete the database because a request appears stuck.
- Patch request/job status in SQLite.
- Replay claim, completion, or failure callbacks with an old token.
- Delete internal candidate refs or worktrees while a job is `finalizing`.
- Re-enqueue a job merely because an HTTP acknowledgement was lost.

These actions discard the fencing and dedupe evidence used to decide whether work may safely resume. Follow [queue-health.md](./queue-health.md) and [queue-playbook.md](./queue-playbook.md) first.

## Intentional full reset

`bun run start -c` is the repository's scoped runtime-clean path. It is destructive and intended for a deliberate fresh start, not incident recovery. Before using it, confirm that no active candidate or publication result must be retained and capture any logs or database evidence needed for diagnosis.

Never implement a reset by recursively deleting an inferred output or worktree path. The startup script validates and scopes its own cleanup targets.

## Configuration maintenance

- Put machine-specific changes in `configs/local.toml`; do not edit generated CLI runtime mirrors by hand.
- Restart RemoteBuddy after changing its planner, worker-spawn, memory, or budget settings.
- `remotebuddy.autonomy.enabled` is the only RemoteBuddy setting currently polled and applied live.
- Use `configs/default.toml` for the complete supported key set. Environment variables found in internal packaging/startup code are not automatically public operator interfaces.

There is no built-in queue purge endpoint, admin state PATCH route, LocalBuddy throttle console, or queue deployment rollback command.
