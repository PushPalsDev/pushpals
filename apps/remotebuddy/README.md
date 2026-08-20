# RemoteBuddy

`apps/remotebuddy` is PushPals' planner and orchestrator. It turns a claimed request into either a direct response or a scoped `task.execute` job. It does not execute code, persist control-plane queues, or decide how commits are published.

## Request Flow

1. Connect to the Server session, monitor lifecycle events, and poll `POST /requests/claim`.
2. Hold the request with its fencing token and renew the claim lease while planning.
3. Combine live context with bounded SQLite memory when enabled, ask `AgentBrain` for a structured plan, then normalize paths, scope, validation commands, priority, and execution budgets.
4. For a direct lane, emit the response and durably complete the request. For a worker lane, idempotently enqueue `task.execute`, record the worker handoff, then complete the planning request.
5. Observe WorkerPal outcomes through session events, update planning memory, maintain worker capacity, and run bounded autonomy when enabled.

## Key Files

- `src/remotebuddy_main.ts` - request loop, planning, handoff, event monitoring, and worker scheduling.
- `src/remotebuddy_supervisor.ts` - bounded crash restart and process-tree shutdown.
- `src/brain.ts` and `src/llm.ts` - structured planner and model adapters.
- `src/command_policy.ts` and `src/path_targeting.ts` - safe validation and repository targeting.
- `src/idempotency.ts` - replay-safe duplicate suppression.
- `src/memory.ts` and `src/persistent_memory.ts` - bounded planning memory.
- `src/worker_spawn.ts` - managed WorkerPal launch commands.
- `src/autonomous_engine.ts` - policy-gated autonomous objective dispatch.

## Commands

Run these from the repository root:

| Goal                                        | Command                                    |
| ------------------------------------------- | ------------------------------------------ |
| Build protocol and start RemoteBuddy        | `bun run remotebuddy`                      |
| Start with the current protocol             | `bun run remotebuddy:only`                 |
| Run the orchestrator directly in watch mode | `bun run remotebuddy:only:watch`           |
| Type-check RemoteBuddy                      | `bun --cwd apps/remotebuddy run typecheck` |
| Start the full stack with preflights        | `bun run start`                            |

The normal start path runs `remotebuddy_supervisor.ts`; watch mode runs `remotebuddy_main.ts` directly.

## State and Recovery

RemoteBuddy stores idempotency records—and, when enabled, planning memory—at `paths.remotebuddy_db_path` (default `outputs/data/remotebuddy-state.db`). Keep that file across ordinary restarts.

- Request claim tokens and lease renewal prevent a stale planner from completing a reclaimed request.
- Job enqueue uses stable dedupe identities. If the acknowledgement is ambiguous, RemoteBuddy leaves the request recoverable instead of reporting a false terminal result; Server reconciliation completes a durable handoff when possible.
- Autonomous dispatch persists a gated reservation before enqueue, allowing startup and periodic reconciliation to repair interrupted dispatch.
- The supervisor applies configured restart limits and backoff after unexpected exits.

## Quick Debug Map

- Request is not moving: inspect `/requests`, the claim lease, and RemoteBuddy polling logs.
- Plan is surprising: inspect planner output, recalled context, path targeting, and command-policy normalization.
- Job is queued but not running: inspect `/workers` and WorkerPal logs; execution is outside RemoteBuddy.
- Repeated work after a restart: inspect the RemoteBuddy state database and Server handoff reconciliation before deleting state.
- Autonomy is idle: inspect eligibility, lock, budget, worker capacity, and publication backlog evidence.

See the [RemoteBuddy wiki](../../docs/wiki/06-remotebuddy.md) for memory configuration and autonomy design. Queue-specific guidance starts with the [queue notes](docs/queue.md).
