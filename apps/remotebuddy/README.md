# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy is the always-on planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

## API Guarantees

- Request lifecycle: `POST /requests/claim` is used to take ownership of queued work, and `POST /requests/:id/complete` finalizes a request once WorkerPal execution succeeds.
- Job orchestration: RemoteBuddy enqueues WorkerPal jobs through the server's `POST /jobs/enqueue` interface and follows up with `POST /jobs/:id/complete|fail` via WorkerPal callbacks.
- Session events: `apps/remotebuddy/src/brain.ts` publishes `assistant_message`, `task_created`, `task_started`, `task_progress`, and `job_enqueued` events to `CommunicationManager`. These event names are part of the observable contract.

## CLI Guarantees

- `bun run dev` and `bun run start` target the watch and production modes defined in `apps/remotebuddy/src/remotebuddy_main.ts`.
- `bun run src/remotebuddy_main.ts -- --server <url> --sessionId <id> --token <auth>` starts a single RemoteBuddy instance. The flags map directly to the arguments parsed in `remotebuddy_main.ts` and are considered stable.

## Implementation Notes (non-contractual)

- `worker_spawn.ts` currently decides when to reuse idle WorkerPals, auto-spawn new ones, and retry when the pool is saturated.
- `command_policy.ts` and `autonomous_engine.ts` jointly determine whether the request should be answered inline or delegated.
- `memory.ts`, `persistent_memory.ts`, and `path_targeting.ts` maintain optional conversational context when the planner chooses to respond without WorkerPal help.

## Worker Routing Policy (non-contractual)

- Lightweight non-actionable prompts can be answered directly.
- Non-trivial actionable prompts are delegated to WorkerPals.
- Architecture/explanation intents can be routed as `project.summary`.
- Code-change intents are routed as `task.execute`.

## Event/Data Flow (non-contractual example)

```text
LocalBuddy -> POST /requests/enqueue -> Server Request Queue
RemoteBuddy -> POST /requests/claim -> plan -> POST /jobs/enqueue
WorkerPals -> POST /jobs/:id/complete|fail (+ optional /completions/enqueue)
SourceControlManager -> POST /completions/claim -> merge/push -> POST /completions/:id/processed|fail
```

## Validation

- `bun run test` executes `bun run test:root` (Bun-powered unit and integration suites under `/tests`) followed by `bun run test:protocol` (`tests/protocol.integration.ts` verifies the protocol schema compiled from `packages/protocol`). There is currently no docs-specific lint; documentation accuracy relies on these automated suites plus manual review.

## References

- Core entrypoint: `apps/remotebuddy/src/remotebuddy_main.ts`
- Planning logic: `apps/remotebuddy/src/brain.ts`
- Worker management: `apps/remotebuddy/src/worker_spawn.ts`
- Memory helpers: `apps/remotebuddy/src/memory.ts`, `apps/remotebuddy/src/persistent_memory.ts`
