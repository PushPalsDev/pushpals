# remotebuddy - RemoteBuddy Orchestrator

RemoteBuddy is the always-on planner/scheduler. It claims requests from the server queue, decides whether a request is lightweight chat or WorkerPal-owned execution, and enqueues scoped jobs for WorkerPals.

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

## Current Workflows

### Request + Planning Loop

- LocalBuddy (or an autonomy objective) enqueues into the server queue; RemoteBuddy polls `POST /requests/claim` on a fixed cadence and immediately emits `assistant_message` + `task_started` status so the UI shows ownership.
- The orchestrator composes context from `recentContext` and persistent memory (`remotebuddy-state.db`, populated via `PersistentSessionMemory`) before calling the planner in `apps/remotebuddy/src/brain.ts`.
- Planner output is normalized: scope/write globs are patched, validation steps are enforced, and deterministic intents can short-circuit as a direct reply without WorkerPals.
- All responses (direct or delegated) are finalized through `POST /requests/:id/complete`, keeping the request queue consistent even when RemoteBuddy answers inline.

### Delegated Execution Workflow

- When `requiresWorker=true`, RemoteBuddy derives execution budgets (`executionBudget*Ms`) and target paths, then enqueues jobs through `/jobs/enqueue`.
- The scheduler tracks `maxWorkers`, `autoSpawnWorkers`, and `waitForWorkerMs` to either attach to an idle WorkerPal or spawn one (`bun run workerpals:only*`), emitting `job_enqueued`/`task_progress` events so LocalBuddy/clients can surface progress.
- Worker outcomes are observed via `CommunicationManager` subscriptions; `job_completed`/`job_failed` events fan back into persistent memory, request completion, and optional `REMOTEBUDDY_FETCH_FAILURE_LOGS` snapshots for debugging.
- Session monitoring keeps a soft heartbeat alive. If the loop stalls (lost SSE/WS, request backlog), RemoteBuddy logs the degraded state and will exit so `start.ts` can restart with a clean claim cursor.

### Autonomous Maintenance Workflow

- When `[remotebuddy.autonomy] enabled=true`, `RemoteBuddyAutonomousEngine` ticks on `CONFIG.remotebuddy.autonomy.tickIntervalMs`, acquires a dispatch lock from the server, and prepares a dedicated git worktree at `.worktrees/remotebuddy-autonomy-<session>`.
- Each tick fetches an autonomy snapshot (`/autonomy/snapshot`), runs ideation/execution LLM phases, filters candidates by policy (scope/risk/write globs), and enqueues objectives back through the same `/requests/enqueue` + `/jobs/enqueue` surfaces with `background` priority.
- Cooldowns (`maxConcurrentObjectives`, `maxDispatchPerHour`, `allowDirtyWorktree`) ensure RemoteBuddy never spams jobs; policy violations or dirty worktrees are logged and leave the system idle until a human intervenes.

## Maintenance Duties

- **Process health:** keep `bun run remotebuddy:only` (or `bun run start`) attached to a terminal so heartbeats, `Session monitor` warnings, and planner failures are visible. RemoteBuddy intentionally exits on repeated transport errors; restart promptly to reclaim pending requests.
- **Configuration + secrets:** align `.env` and `config/local.toml` with server URLs, auth tokens (`--token`), and `[remotebuddy.memory|autonomy]` blocks. Prefer env overrides (`REMOTEBUDDY_MEMORY_*`, `REMOTEBUDDY_AUTONOMY_*`) for quick adjustments without committing sensitive data.
- **Worker scheduling:** set `remotebuddy.max_workers`, `auto_spawn_workers`, and wait/backoff knobs so the orchestrator matches available WorkerPal capacity. Review logs for `Skipping already-handled request` or `Planner write_globs did not cover target paths` to catch policy drift early.
- **Persistent memory hygiene:** monitor the `remotebuddy-state.db` SQLite file (default cwd of `apps/remotebuddy`). Use retention knobs (`REMOTEBUDDY_MEMORY_RETENTION_DAYS`, `max_recall_items/chars`) to bound growth, and vacuum or delete the file only while RemoteBuddy is stopped to reset bias.
- **Autonomy worktree upkeep:** the autonomous engine maintains `.worktrees/remotebuddy-autonomy-*`. Prune these when switching branches or after long pauses so the next tick can re-clone cleanly. If autonomy is disabled, remove stale worktrees to avoid “preflight blocked” logs.
- **Observability + failure logs:** leave `REMOTEBUDDY_FETCH_FAILURE_LOGS=1` set in CI/E2E contexts so failed jobs pull worker logs automatically. Scan `task_progress` events for repeated planner repairs—those often indicate missing protocol updates or schema drift.

## Idle System Cleanup

When RemoteBuddy is idle (no queued requests, no autonomous objectives), reset the runtime state so the next operator starts cleanly:

1. **Stop daemons:** terminate any lingering `bun` processes for RemoteBuddy/WorkerPals/SourceControlManager. The integration tests expose a reference command (`pkill -f "apps/remotebuddy|apps/workerpals|apps/source_control_manager|remotebuddy:only|workerpals:only|source_control_manager:only"`) that safely reaps stray sidecars before new runs.
2. **Drain queues:** check the server (`apps/server`) request/job dashboards or query SQLite (`outputs/data/pushpals.db`) to confirm pending entries are either completed or intentionally left for later. Close any claimed-but-unfinished requests with `POST /requests/:id/complete` + a failure reason so LocalBuddy stops waiting.
3. **Remove autonomy worktrees:** delete `.worktrees/remotebuddy-autonomy-*` if autonomy was enabled. This prevents stale locks/branches from blocking future ticks and keeps disk usage predictable.
4. **Reset memory (optional):** if you need a fresh planning slate, stop RemoteBuddy and remove `apps/remotebuddy/remotebuddy-state.db` (or run `sqlite3 remotebuddy-state.db 'VACUUM'`). The next startup will recreate tables and rebuild recall history from scratch.
5. **Verify config drift:** before restarting later, re-run `bun run start -c` or at least `bun run remotebuddy:only -- --server ... --sessionId ... --token ...` to ensure env/config changes (LLM keys, queue URLs) still align with the rest of PushPals.
