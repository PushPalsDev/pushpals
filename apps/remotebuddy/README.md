# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy is the always-on planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

## Runtime Role

- Claims queued requests by POSTing to `/requests/claim` and serially processing the returned payloads (see `apps/remotebuddy/src/remotebuddy_main.ts:1857-1894`).
- Emits session events through `CommunicationManager`; example event types include `assistant_message`, `task_created`, `task_started`, `task_progress`, and `job_enqueued`, all wired up in `packages/shared/src/communication.ts:30-125`.
- Schedules WorkerPals by picking idle workers, optionally auto-spawning them via `buildWorkerSpawnCommand` in `apps/remotebuddy/src/worker_spawn.ts:12-42`, and waiting/retrying when capacity is full based on the orchestration loop in `apps/remotebuddy/src/remotebuddy_main.ts:700-818`.
- Marks requests complete/fail by POSTing to `/requests/:id/complete` or `/requests/:id/fail` when downstream jobs succeed or error (see `apps/remotebuddy/src/remotebuddy_main.ts:1638-1653` and `apps/remotebuddy/src/remotebuddy_main.ts:1846-1853`).

Example log lines referenced throughout this README (such as `[RemoteBuddy] claim payload: …`) come directly from the `console.log` statements at `apps/remotebuddy/src/remotebuddy_main.ts:1884-1890`; treat them as illustrative samples rather than normative API contracts.

## Usage

Every command here is wired directly to a script entry so you can trace behavior back to the source-of-truth definitions:

```bash
# Watch mode (apps/remotebuddy/package.json#scripts.dev -> bun --watch --no-clear-screen src/remotebuddy_main.ts)
bun --cwd apps/remotebuddy run dev -- --server http://localhost:3001 --sessionId dev --token <auth-token>

# Single-run orchestrator (apps/remotebuddy/package.json#scripts.start -> bun run src/remotebuddy_main.ts)
bun --cwd apps/remotebuddy run start -- --server http://localhost:3001 --sessionId dev --token <auth-token>
```

From the workspace root, the aggregate `package.json#scripts.remotebuddy` target runs `protocol:build` and then calls `package.json#scripts.remotebuddy:only` (which resolves to `bun --cwd apps/remotebuddy --env-file ../../.env start`), so the same env-file driven config applies regardless of where you launch it:

```bash
bun run remotebuddy -- --server http://localhost:3001 --sessionId dev --token <auth-token>
```

All of these scripts ultimately execute `apps/remotebuddy/src/remotebuddy_main.ts`, so invoking `bun run src/remotebuddy_main.ts --server …` manually is only needed for bespoke debugging.

## Local Development Without Session Tokens (Localhost Only)

⚠️ Local-only guard: never run `package.json#scripts.remotebuddy` or `package.json#scripts.remotebuddy:only` without `--token` against shared servers. RemoteBuddy intentionally omits the `Authorization: Bearer …` header whenever no token is provided (see `apps/remotebuddy/src/remotebuddy_main.ts:837-840`), so doing this outside an isolated workstation would let unauthenticated traffic impersonate you.

When you intentionally run a loopback-only server that skips auth, drop the token flag while staying on localhost:

```bash
bun --cwd apps/remotebuddy run dev -- --server http://localhost:3001 --sessionId dev
```

Keep the server bound to `localhost`, avoid tunneling this port, and restore `--token` before connecting to staging, production, or any environment you do not fully control.

## Worker Routing Notes

- Lightweight non-actionable prompts can be answered directly.
- Non-trivial actionable prompts are delegated to WorkerPals.
- Architecture/explanation intents can be routed as `project.summary`.
- Code-change intents are routed as `task.execute`.

These heuristics live in `apps/remotebuddy/src/remotebuddy_main.ts:92-210`, where `isExecutionIntent`, `isArchitectureIntent`, and related helpers analyze each request.

## Event/Data Flow (Illustrative)

_The timeline below illustrates the happy-path interactions; the authoritative HTTP calls live in `apps/remotebuddy/src/remotebuddy_main.ts:1050-1894` and `apps/remotebuddy/src/autonomous_engine.ts:259-551`._

```text
LocalBuddy -> POST /requests/enqueue -> Server Request Queue
RemoteBuddy -> POST /requests/claim -> plan -> POST /jobs/enqueue
WorkerPals -> POST /jobs/:id/complete|fail (+ optional /completions/enqueue)
SourceControlManager -> POST /completions/claim -> merge/push -> POST /completions/:id/processed|fail
```

RemoteBuddy maps that flow into session events via `CommunicationManager` (`packages/shared/src/communication.ts:30-125`), so downstream consumers receive the same `assistant_message`/`task_*` envelopes described earlier.

## Automation Verification

CI enforces these docs by running `package.json#scripts.test`, which chains `test:root` (a `bun test tests` invocation) and `test:protocol`. To reproduce the remotebuddy-specific slice in automation without live tokens or servers, run the same entrypoint with a focused target:

```bash
bun test tests/remotebuddy.worker-spawn-command.test.ts tests/remotebuddy.path-targeting.test.ts tests/remotebuddy.bun-command-policy.test.ts
```

This single command uses the Bun test runner that backs `package.json#scripts.test:root`, covering the worker spawn contract, request routing, and Bun command policy that this README references.
