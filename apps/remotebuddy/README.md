# RemoteBuddy

`apps/remotebuddy` is PushPals' planner and orchestration service. It claims durable requests from Server and turns each one into either a direct assistant response or a scoped `task.execute` job for WorkerPals. Server owns the queues and lifecycle state, WorkerPals own repository execution, and SourceControlManager owns trusted validation and publication.

RemoteBuddy does not expose its own HTTP API. It is a client of Server's loopback API and a producer and consumer of session events.

## Runtime flow

1. Join the configured Server session and subscribe to its event stream.
2. Poll `POST /requests/claim`, then renew the three-minute claim lease every 30 seconds while planning.
3. Ask `AgentBrain` for a structured plan and normalize its target paths, write hints, acceptance criteria, validation commands, priority, and budgets.
4. For chat or status work, publish an assistant response and complete the request.
5. For repository work, select or start a WorkerPal, idempotently enqueue a schema-v2 `task.execute` job, record the durable request-to-job handoff, and complete the planning stage.
6. Observe session events for job outcomes, maintain the worker pool, update bounded planning memory, host the RepositoryAgent worker, and run autonomy when enabled.

RemoteBuddy processes one claimed planning request at a time. Worker execution and publication continue independently after the planning request has completed; the request read model projects its user-visible outcome from the linked job.

## Current boundaries

- Clients normally submit messages directly to Server at `POST /sessions/:id/message`. LocalBuddy is optional and can enqueue through `POST /requests/enqueue` when its `/message` route chooses remote handling.
- RemoteBuddy only creates `task.execute` jobs by polling the request queue. It does not accept direct job submissions.
- Queue state is authoritative in Server's shared SQLite database. RemoteBuddy's own database stores optional planning memory and legacy compatibility tables only; those legacy idempotency methods are not part of the current polling flow.
- RepositoryAgent results are advisory. Deterministic host code still enforces request fencing, job contracts, execution policy, validation, and publication.
- Server URLs are normalized to `127.0.0.1`. CLI `--token` input is retained for compatibility but ignored by the current local-only connection policy.

## Key files

- [`src/remotebuddy_main.ts`](src/remotebuddy_main.ts) - request claims, planning, handoff, event monitoring, RepositoryAgent hosting, and worker scheduling.
- [`src/remotebuddy_supervisor.ts`](src/remotebuddy_supervisor.ts) - bounded crash restart and process-tree shutdown.
- [`src/brain.ts`](src/brain.ts) and [`src/llm.ts`](src/llm.ts) - structured planning and model adapters.
- [`src/autonomous_engine.ts`](src/autonomous_engine.ts) - policy-gated objective generation and durable autonomous dispatch.
- [`src/repository_agent.ts`](src/repository_agent.ts) - bounded-evidence RepositoryAgent worker.
- [`src/command_policy.ts`](src/command_policy.ts) and [`src/path_targeting.ts`](src/path_targeting.ts) - validation-command and repository-target normalization.
- [`src/idempotency.ts`](src/idempotency.ts) - a legacy compatibility store that is instantiated but not consulted by the current request-polling path.
- [`src/memory.ts`](src/memory.ts) and [`src/persistent_memory.ts`](src/persistent_memory.ts) - bounded planning memory.
- [`src/worker_spawn.ts`](src/worker_spawn.ts) - managed WorkerPal launch commands.

`src/startup/checklist.ts` is a tested, dependency-injected checklist library. No production entrypoint currently calls it; the supported runtime preflight is the repository-level `bun run start` flow.

## Running and checking

Run commands from the repository root:

| Goal                                               | Command                                    |
| -------------------------------------------------- | ------------------------------------------ |
| Start the complete stack with supported preflights | `bun run start`                            |
| Build protocol, then start RemoteBuddy             | `bun run remotebuddy`                      |
| Start RemoteBuddy with an already-built protocol   | `bun run remotebuddy:only`                 |
| Run the main process directly in watch mode        | `bun run remotebuddy:only:watch`           |
| Type-check RemoteBuddy                             | `bun run --cwd apps/remotebuddy typecheck` |
| Run RemoteBuddy's colocated tests                  | `bun test apps/remotebuddy/src`            |

The normal `remotebuddy:only` command runs the supervisor. Watch mode bypasses the supervisor and runs `remotebuddy_main.ts` directly.

RemoteBuddy requires Server to be available, but it retries session creation indefinitely with capped exponential backoff. These logs establish basic readiness:

```text
[RemoteBuddy] Using session: ...
[RepositoryAgent] Started shared repository capability (...)
[RemoteBuddy] Starting polling loop (every ...ms)
```

Worker readiness is separate. Inspect `GET /workers`, `GET /workers/autoscale`, and RemoteBuddy's `Worker scheduler`, `Spawning WorkerPal`, or worker-unavailable logs.

## Configuration and state

The supported configuration surfaces are `[remotebuddy]`, `[remotebuddy.llm]`, `[remotebuddy.memory]`, and `[remotebuddy.autonomy]` in [`configs/default.toml`](../../configs/default.toml), with machine overrides in `configs/local.toml`. Worker launch behavior also uses `[workerpals]`.

Only `remotebuddy.autonomy.enabled` is polled for live configuration changes. Treat other RemoteBuddy settings as restart-required.

The state paths come from `[paths]`:

- `shared_db_path` (default `outputs/data/pushpals.db`) is Server-owned queue and lifecycle state.
- `remotebuddy_db_path` (default `outputs/data/remotebuddy-state.db`) stores optional planning-memory records and initializes legacy cursor/handled-message tables. The current request-polling path does not read or write those legacy idempotency tables; it relies on Server claim fencing and job dedupe.

Keep both files across ordinary restarts. Do not delete or edit either database to clear a stuck request: claim expiry, durable handoff reconciliation, and terminal state are implemented by Server.

## Operational documentation

- [Queue model and supported API](docs/queue.md)
- [Monitoring the built-in signals](docs/queue-monitoring.md)
- [Queue health triage](docs/queue-health.md)
- [Queue operations](docs/queue-operations.md)
- [Recovery playbook](docs/queue-playbook.md)
- [Startup and readiness](docs/startup.md)
- [End-to-end request example](docs/request-workflow-example.md)

These documents describe only observability and controls present in this repository. PushPals does not currently ship Grafana dashboards, Alertmanager rules, PagerDuty integrations, Slack incident automation, per-lane worker pools, an admin throttle command, or a worker `--drain` command.

For autonomy and shared-memory design, see the [RemoteBuddy wiki](../../docs/wiki/06-remotebuddy.md).
