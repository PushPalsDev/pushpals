# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy acts as the planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

## Runtime Role

- Claims queued requests: `POST /requests/claim`
- Emits session events via `CommunicationManager`:
  - `assistant_message`
  - `task_created`, `task_started`, `task_progress`
  - `job_enqueued`
- Schedules WorkerPals:
  - picks idle workers
  - optionally auto-spawns workers
  - waits/retries when capacity is full
- Marks requests complete: `POST /requests/:id/complete`

## Usage

Run the scripts defined in `apps/remotebuddy/package.json` (either after `cd apps/remotebuddy` or via `bun --cwd apps/remotebuddy ...`):

```bash
bun run dev
bun run start
```

Direct execution follows the `remotebuddy_main.ts` usage string:

```bash
bun run src/remotebuddy_main.ts --server http://localhost:3001 [--sessionId <id>] [--token <auth>]
```

## Worker Routing Notes

- Lightweight non-actionable prompts can be answered directly.
- Non-trivial actionable prompts are delegated to WorkerPals.
- Architecture/explanation intents can be routed as `project.summary`.
- Code-change intents are routed as `task.execute`.

## Event/Data Flow

```text
LocalBuddy -> POST /requests/enqueue -> Server Request Queue
RemoteBuddy -> POST /requests/claim -> plan -> POST /jobs/enqueue
WorkerPals -> POST /jobs/:id/complete|fail (+ optional /completions/enqueue)
SourceControlManager -> POST /completions/claim -> merge/push -> POST /completions/:id/processed|fail
```
