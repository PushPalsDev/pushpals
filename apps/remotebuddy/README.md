# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy is the always-on planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

## Contributor Onboarding

### Environment setup
- Install Bun 1.1+ (for example `brew install oven-sh/bun/bun`) and ensure Docker is available because RemoteBuddy's default config expects WorkerPals to spawn inside containers.
- From the repo root run `bun install` to pull shared workspace dependencies, then `bun run protocol:build` so RemoteBuddy and the server share the latest protocol types.
- Bring up the API server that owns the request/job queues with `bun run server:only -- --env-file ../../.env` from `apps/server`, then launch RemoteBuddy via `bun run remotebuddy:only -- --sessionId dev --token <server-token>` (omit `--token` when the server trusts your localhost).

### Configuration
- Copy `config/local.example.toml` to `config/local.toml` and adjust the `[server]` or `[remotebuddy]` sections to point at your server URL, preferred session id, and WorkerPal caps. Keeping a unique `remotebuddy.session_id` avoids fighting with teammates.
- Secrets live in `.env` at the repo root. RemoteBuddy's LLM client reads `OPENAI_API_KEY`, `PUSHPALS_OPENAI_CODEX_AUTH_MODE` (chatgpt/api_key/auto), `PUSHPALS_OPENAI_CODEX_BIN` (override command such as `bun x --yes @openai/codex`), and optionally `PUSHPALS_OPENAI_CODEX_BASE_URL`. Export these before running or specify `--env-file ../../.env` when invoking Bun scripts.
- Optional tuning env vars such as `REMOTEBUDDY_SESSION_MONITOR_MAX_WS_ERRORS` and `REMOTEBUDDY_FETCH_FAILURE_LOGS=1` live in the same `.env` file and give more insight when debugging websocket/session health.

### Quiet queue workflow
- **When to use it:** Any time you want to test long-running or experimental prompts without impacting the shared interactive lane. RemoteBuddy claims requests per `sessionId`, so giving yourself a dedicated session keeps the queue "quiet" for everyone else.
- **How to enable it:** Set a session id like `quiet-dev` in `config/local.toml` (`session_id = "quiet-dev"`) or pass `--sessionId quiet-dev` when starting both LocalBuddy and RemoteBuddy. Only those processes will enqueue/claim from that isolated lane.
- **How to enqueue background work:** When posting directly to the server queue use `priority: "background"` to keep items in the quiet lane:
  ```bash
  curl -X POST "$SERVER/requests/enqueue" \
    -H 'Content-Type: application/json' \
    -d '{"sessionId":"quiet-dev","prompt":"run integration smoke suite","priority":"background"}'
  ```
  LocalBuddy already auto-detects "deep dive" prompts and marks them background, but you can force it by adding `priority:"background"` when sending custom payloads.
- **Observing the lane:** Use `curl "$SERVER/requests?sessionId=quiet-dev"` (or LocalBuddy's `/status` view) to confirm the queue is empty before routing live traffic back to the main session, and drop the `--sessionId` override whenever you're ready to rejoin the shared queue.

### Validate changes
- Run `bun run lint` from the repo root before opening a PR so RemoteBuddy, shared protocol types, and any touched packages stay consistent with the workspace lint rules.

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

```bash
bun run dev
bun run start

bun run src/remotebuddy_main.ts \
  --server http://localhost:3001 \
  --sessionId dev \
  --token <auth-token>
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
