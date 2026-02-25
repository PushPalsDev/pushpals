# RemoteBuddy (`apps/remotebuddy`)

RemoteBuddy is the always-on planner/orchestrator. It claims requests from the Server queue, decides whether a prompt can be answered directly or must be executed by WorkerPals, emits session events via `CommunicationManager`, enqueues/scopes jobs, and closes out requests (`POST /requests/:id/complete`).

## Boundary & Responsibilities

| Component | Responsibilities | APIs touched |
| --- | --- | --- |
| **LocalBuddy** (`apps/localbuddy`) | User ingress on `POST /message`, handles status/lookups/lightweight chat, enqueues heavier prompts. | `POST /requests/enqueue` |
| **RemoteBuddy** (`apps/remotebuddy`) | Claims queued requests, plans tasks, emits `assistant_message`, `task_*`, `job_enqueued`, optionally spawns WorkerPals, completes requests or escalates failures. | `POST /requests/claim`, `POST /jobs/enqueue`, `POST /requests/:id/(complete|fail)` |

### Dependency Snapshot

- **LocalBuddy → RemoteBuddy**: LocalBuddy forwards anything heavier than a lightweight chat to the shared Server queue via `POST /requests/enqueue`.
- **RemoteBuddy → WorkerPals**: RemoteBuddy enqueues jobs via `POST /jobs/enqueue`, then WorkerPals claim from `POST /jobs/claim`.
- **CommunicationManager** fans out `assistant_message`, `task_*`, and completion events so LocalBuddy can answer client polling/SSE requests.

```text
Client -> LocalBuddy --POST /requests/enqueue--> Server Queue <--POST /requests/claim-- RemoteBuddy
RemoteBuddy --POST /jobs/enqueue--> Server Job Queue <--POST /jobs/claim-- WorkerPals
RemoteBuddy -> CommunicationManager -> UI + LocalBuddy status responders
```

## Architecture Overview (On-Call Crash Course)

RemoteBuddy runs as the single Bun process in `apps/remotebuddy/src/remotebuddy_main.ts`. It polls the server queue, plans via an LLM-backed `AgentBrain`, and either replies inline or ships structured `task.execute` work to WorkerPals while streaming events through `CommunicationManager`. Keep the following mental model in mind when debugging:

```text
POST /requests/claim
        │
        ▼
IdempotencyStore (SQLite remotebuddy-state.db) ──► AgentBrain + SessionMemory
        │                                               │
        │                            assistant_message / task_* events via CommunicationManager
        │                                               ▼
        └──────► Planner output + path/command policy ──► POST /jobs/enqueue → WorkerPals
                                            ▲
                                            │
                                   RemoteBuddyAutonomousEngine (queue health + remediation)
```

### Core subsystems

- **Request poller & idempotency** – `RemoteBuddyOrchestrator` hits `POST /requests/claim` every ~2 s, then de-dupes messages through `IdempotencyStore` so crashes/retries do not replay finished prompts. The store, together with cursors, lives in `remotebuddy-state.db` inside the repo root; back it up (or delete intentionally) if the file becomes corrupted.
- **Planner, memory & heuristics** – `AgentBrain` (LLM) and `LLMClient` evaluate prompts, hydrate `SessionMemory`/`PersistentSessionMemory`, and call `path_targeting` plus `command_policy` helpers to normalize scope, target paths, validation, and execution guidance before anything is handed to WorkerPals. This is where most “why did it plan that?” questions originate.
- **Task/worker coordination** – The orchestrator emits `assistant_message`, `task_*`, and completion payloads via `CommunicationManager`, then enqueues WorkerPal jobs with `POST /jobs/enqueue`. If extra capacity is required, `worker_spawn.ts` can build the exact `bun run apps/workerpals` command RemoteBuddy launches automatically to keep ≥`maxWorkers` idle.
- **Autonomy + queue automation** – `RemoteBuddyAutonomousEngine` consumes signals such as `sig_queue_health`, retry streaks, and regret telemetry. It can enqueue synthetic remediation tasks labeled `origin=autonomy`, each pre-populated with `write_globs`/`target_paths`. Operators should only edit those scopes when they’ve proved the automation was wrong.
- **Observability & recovery** – `CommunicationManager.subscribeSessionEvents` keeps a WebSocket open for `job_failed`/`job_completed` envelopes so RemoteBuddy can annotate memory and immediately inform users. Long-running hosts should use `bun --cwd apps/remotebuddy run start` (which runs `remotebuddy_supervisor.ts`) so the agent auto-restarts on crashes while reusing the same `remotebuddy-state.db`.

For deeper internals, inspect `apps/remotebuddy/src/*.ts` alongside `packages/shared`, but this overview should be enough for on-call triage.

## Quick Start Workflow

Use this high-level flow while bringing a new machine online:

1. Complete the steps in the [Setup Checklist](#setup-checklist) so Bun, dependencies, configs, and helper tools exist locally.
2. Acquire a bearer token (or confirm auth is disabled) using the [Token Setup and Verification](#token-setup-and-verification) steps.
3. Start the supporting services you need (typically `bun run server:only`, optionally LocalBuddy/WorkerPals) before launching RemoteBuddy.
4. Run `bun run remotebuddy` from the repo root for the recommended entry point, or pick another command from [Usage Commands](#usage-commands) when you need a specific mode.
5. Validate the round trip with the [Runtime Smoke Test](#runtime-smoke-test) so you catch queue, auth, or worker issues before handling real traffic.

## Setup Checklist

RemoteBuddy reuses the repo-wide toolchain (Bun + `.env`). Work through the steps below in order; each step calls out the platform-specific commands you can reuse later.

### Step 1: Install Bun 1.x

- macOS/Linux (bash/zsh):
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- Windows PowerShell (native):
  ```powershell
  irm https://bun.sh/install.ps1 | iex
  ```

### Step 2: Install workspace dependencies

- macOS/Linux:
  ```bash
  cd /path/to/pushpals
  bun install
  ```
- Windows PowerShell:
  ```powershell
  Set-Location C:\path\to\pushpals
  bun install
  ```

### Step 3: Seed local config files

- macOS/Linux:
  ```bash
  cp .env.example .env
  cp config/local.example.toml config/local.toml
  ```
- Windows PowerShell:
  ```powershell
  Copy-Item .env.example .env
  Copy-Item config\local.example.toml config\local.toml
  ```

### Step 4: Install `jq` for status checks (`curl ... | jq`)

- macOS:
  ```bash
  brew install jq
  ```
- Debian/Ubuntu:
  ```bash
  sudo apt-get update && sudo apt-get install -y jq
  ```
- Windows PowerShell:
  ```powershell
  winget install --id jqlang.jq --source winget
  # or: choco install jq
  ```

## Bun Workflow

**Prerequisites** – Follow the repo-wide Bun 1.x requirement from the [Setup Checklist](#setup-checklist); RemoteBuddy is validated on Bun 1.1.x today. Confirm with `bun --version`, then reinstall via `curl -fsSL https://bun.sh/install | bash` (macOS/Linux) or `powershell -c "irm https://bun.sh/install.ps1 | iex"` (Windows) if the version lags.

**Run these from the repo root** (the folder containing `apps/remotebuddy`). The root `package.json` owns the build/test/lint scripts; running inside `apps/remotebuddy` will throw `Script not found "build"`/`"test"` unless you prefix commands with `bun --cwd ../..`.

```bash
bun install
bun run build
bun test
bun run lint
```
- Windows PowerShell:
  ```powershell
  bun install
  bun run build
  bun test
  bun run lint
  ```

- `bun run build` is the RemoteBuddy build step; if your local root package.json predates the alias and errors, run `bun run protocol:build` instead.
- `bun test` must run from the repo root so the shared tests and `package.json` scripts resolve; inside the app directory use `bun --cwd ../.. test` (or `bun run test`) to avoid `Script not found "test"`.

Troubleshooting – If Bun crashes, loops on cache errors, or still reports missing scripts, clear the cache via `bun pm cache rm --all`, reinstall Bun with the commands above, ensure you are in the repo root, then rerun the workflow.

## Runtime Role Reference

- Claims queued requests (`POST /requests/claim`).
- Emits session events via `CommunicationManager`: `assistant_message`, `task_created`, `task_started`, `task_progress`, `job_enqueued`.
- Schedules WorkerPals (picks idle workers, optionally auto-spawns, retries when capacity is full).
- Marks requests complete/fail (`POST /requests/:id/complete` or `/fail`).
- Follows routing heuristics:
  - Lightweight, non-actionable prompts => respond directly.
  - Architecture/explanation intents => `project.summary`.
  - Code-change intents => `task.execute` delegated to WorkerPals.

## Operational Runbook (Updated Feb 2026)

### Queue & escalation thresholds (source of truth)

| Signal | Warning (self-triage) | Incident / paging | Linked response |
| --- | --- | --- | --- |
| `queue_p95` (`slo.requests.queueWaitMs.p95`) | ≥ 1.0 s for 3 consecutive `/system/status` polls **or** ≥ 0.3 s jump between adjacent polls | ≥ 1.5 s for 5 min **or** ≥ 2.0 s for 2 polls without recovery | Follow [Queue health monitoring & triage](#queue-health-monitoring--triage) to freeze background/eval load, confirm automation fired, and post status in `#pushpals-ops`. |
| Pending interactive / queue depth | ≥ 15 interactive requests (or total pending > 35) for ≥ 3 polls | ≥ 30 interactive (or total pending > 60) for ≥ 5 min | Trigger the queue-playbook diagnostics, throttle enqueueing to interactive-only, then coordinate extra WorkerPal capacity per [Queue-handling flow](#queue-handling-flow-current-state). |
| Idle WorkerPals per lane | < 3 idle workers per lane for ≥ 3 polls | ≤ 1 idle worker cluster-wide for ≥ 5 min (automation unable to auto-spawn) | Treat as capacity loss; loop WorkerPals/Platform on-call and follow the worker restart path in `apps/remotebuddy/docs/queue-playbook.md`. |
| `job_failure_rate` (rolling 10 min) | ≥ 0.25 | ≥ 0.40 | Pull recent WorkerPals logs, look for retry storms/regressions, prep worker restarts, and engage Platform once the row hits the Incident column. |

The table above is the single source of truth for queue/escalation thresholds. Keep it in lockstep with [`apps/remotebuddy/docs/queue-health.md`](apps/remotebuddy/docs/queue-health.md); the remainder of this runbook references these rows instead of repeating thresholds.

### Queue health monitoring & triage

- **Telemetry watchlist** – Keep `/system/status` tailing so you can see `slo.requests.queueWaitMs.p95` (aka `queue_p95`) alongside `queues.requests.pending`, and pin Grafana’s WorkerPals Job Outcomes panel for `job_failure_rate` (task.execute failures / total jobs in the last 10 minutes). Pair those with `sig_queue_health` logs so autonomous spikes are surfaced even when dashboards lag.
- **Alert thresholds** – Use the [Queue & escalation thresholds](#queue--escalation-thresholds-source-of-truth) table only. Hit the warning column as soon as any row drifts for ≥3 polls so you can stop background traffic before pages fire.

- **Fast load-spike detection tips** – Keep a live poll plus log tail going so you see spikes before alerts aggregate.
  - macOS/Linux:
    ```bash
    SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
    watch -n 5 curl -sS "$SERVER/system/status" \
      -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" \
      | jq '{p95: .slo.requests.queueWaitMs.p95, pending: .queues.requests.pending, jobs: .queues.jobPendingSnapshot}'
    tail -f logs/remotebuddy.log | rg sig_queue_health
    ```
  - Windows PowerShell:
    ```powershell
    $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
    while ($true) {
      Invoke-RestMethod -Uri "$server/system/status" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
        Select-Object @{Name="p95";Expression={$_.slo.requests.queueWaitMs.p95}}, @{Name="pending";Expression={$_.queues.requests.pending}}, @{Name="jobs";Expression={$_.queues.jobPendingSnapshot}}
      Start-Sleep -Seconds 5
    }
    Get-Content -Path logs\\remotebuddy.log -Wait | Select-String -Pattern 'sig_queue_health'
    ```
  When `queue_p95` jumps ≥0.3 s between polls, immediately check `/requests?status=pending&limit=20` for aging interactive prompts and manually re-prioritize them.
- **Escalation steps** – 1) Announce the metric breach with snapshots in `#pushpals-ops`; 2) loop WorkerPals/Platform on-call if warning bands last >10 minutes or `job_failure_rate` crosses 0.4; 3) page Infrastructure/SRE if worker restarts do not clear the spike or shared services look unhealthy. Keep time-stamped updates every 15 minutes until `queue_p95` < 1.0 s and `job_failure_rate` < 0.2 for two consecutive polls.

#### Queue monitoring & recovery runbook (TL;DR)

Keep this section handy when p95, regret, or autonomy signals start drifting between full incident reviews.

| Signal | Dashboards / logs | Warning (self-triage) | Page / escalate |
| --- | --- | --- | --- |
| `queue_p95` | Grafana › RemoteBuddy Queue Overview (`queue_p95` panel); `/system/status.slo.requests.queueWaitMs` snapshots; `tail -f logs/remotebuddy.log` for planner budget hits. | ≥ 1.0 s for 3 polls **or** pending interactive ≥ 15. | ≥ 1.5 s for 5 min **or** queue depth > 60 / < 2 idle workers; page **RemoteBuddy Platform** and ping `@workerpals-oc` for surge capacity. |
| Reopenings (`reopened_within_24h`) | Grafana › Autonomy board (`reopenings_24h` panel); `sqlite3 autonomy.db 'select count(*) from autonomy_outcomes where reopened_within_24h=1 and datetime(created_at)>=datetime(\"now\",\"-24 hours\")'`; WorkerPal transcripts via `logs/workerpals*.log`. | ≥ 3 reopenings in 24 h or any request reopened twice. | ≥ 6 reopenings / 24 h or rising trend 30 min; notify `@remote-autonomy` and prep rollback of the newest planner/autonomy change. |
| `sig_queue_health` | `tail -f logs/remotebuddy.log | rg sig_queue_health`; Grafana alert `queue_health_forceWorker`; `/system/status.autonomySignals`. | Value ≥ 0.45 for 3 polls **or** ≥ 2 synthetic `forceWorker` jobs/minute. | Value ≥ 0.75 for ≥10 min or auto-remediation loop detected; escalate to **WorkerPals Runtime** for restarts + capacity audit. |
| `sig_regret_24h` | `tail -f logs/remotebuddy.log | rg sig_regret_24h`; Grafana › Autonomy signals; alert payload evidence lines. | Value ≥ 0.5 (≈3 reopenings) for 2 polls. | Value ≥ 0.8 (≥5 reopenings) or paired with user-visible regressions; engage **RemoteBuddy Platform** + SRE immediately. |

- **Bookmark these views:** Grafana RemoteBuddy Queue Overview + Autonomy signal boards, `/system/status` JSON saved per poll, `logs/remotebuddy.log`, `logs/server.log`, and the deep-dive docs in `apps/remotebuddy/docs/queue-monitoring.md` + `queue-playbook.md`.

**Low-traffic response checklist (idle window regression)**

1. Capture evidence – Export `queue_p95` + autonomy Grafana snapshots, run `/system/status` + reopening SQL above, paste results in `#pushpals-ops` with timestamps.
2. Stabilize demand – Force LocalBuddy/background throttles to interactive-only, cancel eval submissions, and confirm `forceWorker` automation isn’t piling on (pending synthetic requests stay flat).
3. Inspect regret roots – Pull the latest reopened request IDs from `autonomy_outcomes` and WorkerPal logs, fix or pause the offending planner patterns before replaying users.
4. Roll back – If `queue_p95` ≥ 1.0 s or reopenings ≥ 3 for >10 min, follow the queue-playbook rollback (`git checkout remotebuddy-queue-lowload-*`, `bun run remotebuddy`) and note the restored commit/config in the ops thread.
5. Escalate – Page PagerDuty **RemoteBuddy Platform**, tag `@remote-autonomy`, and keep Infra/SRE looped if `sig_queue_health` ≥ 0.75 or `sig_regret_24h` ≥ 0.8 after rollback; continue status posts every 15 min until signals clear.

**High-traffic response checklist (backlog / incident state)**

1. Snapshot telemetry – Grab `/system/status`, queue/backlog Grafana panels, and `sig_*` log excerpts; specify organic vs synthetic load in `#pushpals-ops`.
2. Add capacity – Launch extra WorkerPals via `bun run workerpals:only[:docker]`, confirm ≥ 3 idle interactive slots and auto-spawn is caught up (`/workers` idle counts).
3. Drain + debug – Pause non-critical lanes, tail WorkerPals logs for retry storms, fail/redo reopened head-of-line requests, and re-run `/requests?status=pending` until wait budgets clear.
4. Roll back / redeploy – If metrics stay red after 10 min, revert the most recent RemoteBuddy/Server release through the [On-Call Deployment Flow](#on-call-deployment-flow-summary), documenting the rollback command, build, and state DB handling.
5. Escalate – Page **WorkerPals Runtime** when idle < 2 or `job_failure_rate` ≥ 0.4, escalate to Infrastructure/SRE if backlog > 60, cross-region impact, or automation loops; keep PagerDuty + Slack timelines updated with owner/ETA.

### Queue-handling flow (current state)

1. RemoteBuddy polls `POST /requests/claim` every ~2 s, dedups via the idempotency cache, and computes `queueWaitBudgetMs` (≥ 20 s interactive, 90 s default, 240 s background).
2. If observed wait exceeds the budget, RemoteBuddy immediately posts an assistant update and fast-tracks planning so the request becomes the next dispatch regardless of priority lane.
3. Planner output determines whether to reply directly or enqueue a WorkerPal job. When a worker is required, RemoteBuddy normalizes scope globs, enforces acceptance/validation steps, selects a lane, and emits `task_*` + `job_enqueued` events before calling `POST /jobs/enqueue`.
4. **Recent automation (Jan–Feb 2026):**
   - The Server autonomy snapshot now emits `sig_queue_health` whenever `queue_p95` or job failure rate trend upward. RemoteBuddy’s autonomous engine consumes that signal and auto-enqueues `forceWorker` background remediation requests (metadata `origin=autonomy`, lane `worker`) so backlogs are drained without a manual query.
   - Auto-spawn logic keeps ≥`maxWorkers` online by launching WorkerPals when `/workers` reports fewer than the configured minimum; treat these workers as ephemeral and avoid manually claim-stealing from them.
   - Queue-health automation tags each synthetic request with explicit `write_globs` and `target_paths`. Operators should leave those untouched; override only when scope corrections are verified, then reply in the originating request so the engine stops re-firing.
5. Completion: successful runs call `POST /requests/:id/complete`; failures post `/fail` with the planner error so LocalBuddy/UI surface transparent status.

> For deeper recovery steps, pair this section with `apps/remotebuddy/docs/queue-playbook.md` (kept in sync with this README every time the runbook changes).

### Guardrails for queue_p95 ≈ 0

Treat the [Queue & escalation thresholds](#queue--escalation-thresholds-source-of-truth) as canonical:

- When every row sits inside the “Warning (self-triage)” column, consider the system healthy enough for hourly `/system/status` spot checks; stay ready to pause background/eval load the moment `queue_p95` or pending interactive drift upward.
- When either the `queue_p95`, pending interactive, or idle-worker rows hit the Warning column for ≥3 polls, trigger the queue-playbook diagnostics, verify automation already injected remediation requests, and pause new background/eval submissions until metrics normalize.
- When any row crosses into the “Incident / paging” column, immediately announce in `#pushpals-ops`, throttle enqueueing to interactive-only, add WorkerPal capacity, and keep `jobPendingSnapshot` visible. Page Platform if the incident column holds for >10 minutes or if auto-spawn cannot restore ≥2 idle workers.

### Operator checkpoints (per rotation)

- `/system/status` snapshot → confirm `queues.requests.pending`, `slo.requests.queueWaitMs`, and `jobPendingSnapshot` stay at/near zero; log anomalies in the ops doc.
  - macOS/Linux:
    ```bash
    SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
    curl -sS "$SERVER/system/status" \
      -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" \
      | jq '{pending: .queues.requests.pending, queue_p95: .slo.requests.queueWaitMs.p95, jobs: .queues.jobPendingSnapshot}'
    ```
  - Windows PowerShell:
    ```powershell
    $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
    Invoke-RestMethod -Uri "$server/system/status" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
      Select-Object @{Name="pending";Expression={$_.queues.requests.pending}}, @{Name="queue_p95";Expression={$_.slo.requests.queueWaitMs.p95}}, @{Name="jobs";Expression={$_.queues.jobPendingSnapshot}}
    ```
- `/requests?status=pending&limit=20` → ensure interactive requests have `createdAt` within the last minute; anything older gets re-queued or force-completed depending on owner feedback.
  - macOS/Linux:
    ```bash
    SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
    curl -sS "$SERVER/requests?status=pending&limit=20" \
      -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" | jq '.requests[] | {id, priority, createdAt}'
    ```
  - Windows PowerShell:
    ```powershell
    $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
    Invoke-RestMethod -Uri "$server/requests?status=pending&limit=20" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
      Select-Object -ExpandProperty requests | Select-Object id, priority, createdAt
    ```
- `/jobs?status=pending` + WorkerPals logs → verify no job kind is retrying > 3 times; reboot workers stuck `busy` without logs.
  - macOS/Linux:
    ```bash
    SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
    curl -sS "$SERVER/jobs?status=pending" \
      -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" | jq '.jobs[] | {id, retries, lane}'
    tail -f logs/workerpals.log
    ```
  - Windows PowerShell:
    ```powershell
    $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
    Invoke-RestMethod -Uri "$server/jobs?status=pending" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
      Select-Object -ExpandProperty jobs | Select-Object id, retries, lane
    Get-Content -Path logs\\workerpals.log -Wait
    ```
- `/workers` → use the Idle WorkerPals row from the [Queue & escalation thresholds](#queue--escalation-thresholds-source-of-truth) table (keep ≥ 3 idle per lane and ≥ 2 cluster-wide). If automation hasn’t reached `maxWorkers`, start another `bun run workerpals` instance locally or in the pool.
  - macOS/Linux:
    ```bash
    SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
    curl -sS "$SERVER/workers" \
      -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" | jq '.workers[] | {id, idle, lane}'
    ```
  - Windows PowerShell:
    ```powershell
    $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
    Invoke-RestMethod -Uri "$server/workers" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
      Select-Object -ExpandProperty workers | Select-Object id, idle, lane
    ```
- `apps/remotebuddy/docs/queue-playbook.md` → follow the mitigation checklist whenever any checkpoint crosses the warning threshold.

### On-call escalation path

1. **RemoteBuddy primary (24 × 7 rotation):** acknowledge dashboard/webhook alerts within 5 minutes, run the checkpoints above, and document steps in `#pushpals-ops`.
2. **WorkerPals/Platform secondary:** ping the platform on-call (same rotation as WorkerPals) if queue guardrails enter “Degradation” or “Incident” bands for >10 minutes, or if auto-spawn cannot reach ≥2 idle workers.
3. **Infrastructure/SRE tertiary:** escalate to infra on-call when degradation roots in shared services (LLM vendor, git, registry) or when queue automation repeatedly re-enqueues the same remediation instruction after operators intervene.
4. Keep a rolling incident log (timestamp, metric snapshot, corrective action) and attach it to the follow-up RCA if paging was required.

## On-Call Deployment Flow (Summary)

### Deterministic release + rollback pre-checks

Complete these steps before you bounce RemoteBuddy so every redeploy/rollback references an explicit release tag or commit SHA:

1. **Sync and list release anchors** – Run the same commands on macOS/Linux or Windows PowerShell:
   ```bash
   git fetch --tags origin --prune
   git for-each-ref --sort=-creatordate --count=5 refs/tags/release-* \
     --format='%(refname:short) %(objectname:short) %(creatordate:short)'
   ```
   - Windows PowerShell:
     ```powershell
     git fetch --tags origin --prune
     git for-each-ref --sort=-creatordate --count=5 refs/tags/release-* `
       --format='%(refname:short) %(objectname:short) %(creatordate:short)'
     ```
   Pick the tag you intend to deploy (e.g., `release-2026.02.24.1`) or, if running an emergency rollback, the last-known-good SHA from this list.
2. **Confirm the code you are about to run** – Document the commit in `#pushpals-ops` by pasting `git show <tag-or-sha> --stat --oneline -n 1` output and recording `git rev-parse <tag-or-sha>`.
3. **Ensure a clean workspace** – `git status --short` must be empty (stash or commit local edits) so the checkout is deterministic.
4. **Run preflight checks before restart** – Use the same commands on every platform so the release is proven before downtime:
   - macOS/Linux:
     ```bash
     bun install
     bun run docs:validate
     bun run smoke
     ```
   - Windows PowerShell:
     ```powershell
     bun install
     bun run docs:validate
     bun run smoke
     ```
   `bun run docs:validate` confirms docs/anchors/commands stay in sync, and `bun run smoke` exercises the queue round-trip against your staging or local stack.

Use this path any time you need to redeploy RemoteBuddy because of a regression, host reboot, or planned change. The goal is to minimize queue downtime while keeping provenance crystal clear.

1. **Stabilize & communicate** – Post intent in `#pushpals-ops`, capture the latest `/system/status` snapshot, and pause new background/eval submissions if any metric from the [Queue & escalation thresholds](#queue--escalation-thresholds-source-of-truth) table is already in the Warning column. Confirm another operator is watching WorkerPals capacity before you bounce RemoteBuddy.
2. **Check out the targeted release** – Pin the runtime to the tag/SHA from the pre-checks. Either detach the existing repo (`git switch --detach <release-tag-or-sha>`) or create a clean worktree so another operator can keep `main` handy:
   - macOS/Linux:
     ```bash
     git worktree add -f .worktrees/remotebuddy-release <release-tag-or-sha>
     cd .worktrees/remotebuddy-release
     ```
   - Windows PowerShell:
     ```powershell
     git worktree add -f .worktrees/remotebuddy-release <release-tag-or-sha>
     Set-Location .worktrees/remotebuddy-release
     ```
   Never follow moving branches or `git pull` during rollback. After checkout, compare `bun.lock`/`package.json`; if they changed relative to the last deploy, run `bun install`. Double-check `.env` and `config/local.toml` still contain the right `PUSHPALS_*` entries.
3. **Build protocol + start the process** – Prefer the repo-root script `bun run remotebuddy` (executes `protocol:build` first, then `remotebuddy:only`). When protocols are already current, `bun run remotebuddy:only` or `bun --cwd apps/remotebuddy run start` (enables `remotebuddy_supervisor.ts` restarts) keeps downtime minimal. Keep the existing terminal or tmux pane open so you can tail logs live.
4. **Validate the new instance** – Wait for `[RemoteBuddy] Starting polling loop…` followed by at least one `claim payload` log. Immediately hit the health probes below, then optionally run `bun run smoke` or enqueue a single interactive request.
   - macOS/Linux:
     ```bash
     SERVER=${PUSHPALS_SERVER_URL:-http://localhost:3001}
     curl -sS "$SERVER/system/status" \
       -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" \
       | jq '{queues: .queues.requests, jobs: .jobPendingSnapshot}'
     curl -sS "$SERVER/requests?status=claimed&limit=5" \
       -H "Authorization: Bearer ${PUSHPALS_AUTH_TOKEN:-}" | jq '.requests[].id'
     ```
   - Windows PowerShell:
     ```powershell
     $server = $env:PUSHPALS_SERVER_URL; if (-not $server) { $server = "http://localhost:3001" }
     Invoke-RestMethod -Uri "$server/system/status" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
       Select-Object @{Name="queues";Expression={$_.queues.requests}}, @{Name="jobs";Expression={$_.jobPendingSnapshot}}
     Invoke-RestMethod -Uri "$server/requests?status=claimed&limit=5" -Headers @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" } |
       Select-Object -ExpandProperty requests | Select-Object id
     ```
   Confirm `queue_p95`, worker idle counts, and the CommunicationManager WebSocket reconnect cleanly.
5. **Observe + prep rollback** – Watch logs for 5–10 minutes. If failures persist, stop the process, record the problematic commit SHA, then follow the [Deterministic rollback playbook](#deterministic-rollback-playbook). Move `remotebuddy-state.db` aside only when it is clearly corrupted (RemoteBuddy will recreate it, but previously-handled events may replay once). Document the outcome and handoff time in `#pushpals-ops`.

### Deterministic rollback playbook

1. Identify the last-known-good release from the pre-check notes or `git for-each-ref` output, then pin it in a clean worktree. Capture `git rev-parse HEAD` and post it in `#pushpals-ops` so future responders know which commit is live.
   - macOS/Linux:
     ```bash
     git worktree add -f .worktrees/remotebuddy-rollback <release-tag-or-sha>
     cd .worktrees/remotebuddy-rollback
     git rev-parse HEAD
     ```
   - Windows PowerShell:
     ```powershell
     git worktree add -f .worktrees/remotebuddy-rollback <release-tag-or-sha>
     Set-Location .worktrees/remotebuddy-rollback
     git rev-parse HEAD
     ```
2. Run the standard preflight trio so dependencies, docs, and queue smoke stay aligned:
   - macOS/Linux:
     ```bash
     bun install
     bun run docs:validate
     bun run remotebuddy
     ```
   - Windows PowerShell:
     ```powershell
     bun install
     bun run docs:validate
     bun run remotebuddy
     ```
3. Re-run the validation commands from step 4 above plus `bun run smoke` if time permits, and annotate the incident log with “rolled back to <tag> (<sha>) at <timestamp>”.
4. Keep monitoring until every metric in the [Queue & escalation thresholds](#queue--escalation-thresholds-source-of-truth) table returns to the “Warning” column or better; escalate when it does not.

## Usage Commands

### Repo Root Scripts (validated against `package.json`)

| Use case | Run from repo root | Script body | Working directory during execution |
| --- | --- | --- | --- |
| Build protocol + start RemoteBuddy (recommended path) | `bun run remotebuddy` | `protocol:build` → `remotebuddy:only` | Root during build, then `apps/remotebuddy` via `--cwd` |
| Start RemoteBuddy with `.env` wiring only | `bun run remotebuddy:only` | `bun --cwd apps/remotebuddy --env-file ../../.env start` | `apps/remotebuddy` |
| Hot reload/watch mode | `bun run remotebuddy:only:watch` | `bun --cwd apps/remotebuddy --env-file ../../.env dev` | `apps/remotebuddy` |

> Tip: Keep `bun run server:only` running in another terminal so the claim/complete round-trip works.

### App-Local Scripts (`cd apps/remotebuddy` first)

| Command | Working directory | Description |
| --- | --- | --- |
| `bun run start` | `apps/remotebuddy` | Runs `src/remotebuddy_main.ts` once (root `remotebuddy:only` delegates here). |
| `bun run dev` | `apps/remotebuddy` | `bun --watch --no-clear-screen src/remotebuddy_main.ts` for rapid iteration. |

### Direct CLI Invocation

```bash
cd apps/remotebuddy
bun run src/remotebuddy_main.ts \
  --server ${PUSHPALS_SERVER_URL:-http://localhost:3001} \
  --sessionId ${PUSHPALS_SESSION_ID:-dev} \
  --token ${PUSHPALS_AUTH_TOKEN:-<optional>}
```

- `--server`, `--sessionId`, and `--token` override values loaded from `config/*.toml` + `.env`.
- When `--token` is omitted, the process uses `PUSHPALS_AUTH_TOKEN` (if set) or runs without auth headers.

## Token Setup and Verification

RemoteBuddy and Server share the same bearer token (`PUSHPALS_AUTH_TOKEN`). The steps below cover creating that token, validating auth, and falling back to tokenless mode when needed.

1. **Generate/store the token**
   - macOS/Linux:
     ```bash
     export AUTH_TOKEN=$(openssl rand -hex 32)
     echo "PUSHPALS_AUTH_TOKEN=$AUTH_TOKEN" >> .env
     ```
   - Windows PowerShell:
     ```powershell
     $env:AUTH_TOKEN = [guid]::NewGuid().ToString("N")
     Add-Content -Path .env -Value "PUSHPALS_AUTH_TOKEN=$env:AUTH_TOKEN"
     ```
2. **Verify guarded access (success path)**
   - Bash/zsh:
     ```bash
     curl -i \
       -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
       "http://localhost:3001/requests?limit=1"
     # Expect HTTP/1.1 200 OK + `{ "ok": true, ... }`
     ```
   - Windows PowerShell:
     ```powershell
     $headers = @{ Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" }
     $resp = Invoke-WebRequest -Uri "http://localhost:3001/requests?limit=1" -Headers $headers -Method Get
     $resp.StatusCode # Expect 200
     $resp.Content    # Contains `{ "ok": true, ... }`
     ```
3. **Verify guarded access (failure path)**
   - Bash/zsh:
     ```bash
     curl -i \
       -H "Authorization: Bearer wrong-token" \
       "http://localhost:3001/requests?limit=1"
     # Expect HTTP/1.1 401 Unauthorized + `{ "ok": false, "message": "Unauthorized" }`
     ```
   - Windows PowerShell:
     ```powershell
     $badHeaders = @{ Authorization = "Bearer wrong-token" }
     try {
       Invoke-WebRequest -Uri "http://localhost:3001/requests?limit=1" -Headers $badHeaders -Method Get -ErrorAction Stop
     } catch {
       $_.Exception.Response.StatusCode.value__ # 401
       $_.Exception.Response.StatusDescription  # Unauthorized
     }
     ```
4. **Run without a token**
   - Remove/comment `PUSHPALS_AUTH_TOKEN` from `.env` then `unset PUSHPALS_AUTH_TOKEN` (bash) or `Remove-Item Env:PUSHPALS_AUTH_TOKEN` (PowerShell).
   - Restart Server + RemoteBuddy. `SessionManager.validateAuth` now allows requests without the header. Repeat the success curl/PowerShell calls without the `Authorization` header and expect HTTP 200.
5. **Diagnose auth failures (canonical signals)**
   - HTTP view: every `POST /requests/claim` responds with `401`, and curl/PowerShell output contains `{ "ok": false, "message": "Unauthorized" }`.
   - RemoteBuddy log view: `Starting polling loop...` repeats without `claim payload` lines because polls are rejected.
   - Server log view: `[POST] /requests/claim 401` paired with `auth=invalid-token` metadata.
   - Fix by aligning RemoteBuddy’s `--token` flag or `PUSHPALS_AUTH_TOKEN` env var with the Server token and restarting both processes.

## Runtime Smoke Test

Run this checklist after `bun run lint` passes so you confirm queue + auth paths before touching user requests. All curl/PowerShell examples assume a tokenized server; omit the header if you are running open access.

1. **Enqueue a synthetic request**
   - Bash/zsh:
     ```bash
     curl -sS -X POST http://localhost:3001/requests/enqueue \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
       -d '{"sessionId":"dev","prompt":"List repo packages","priority":"interactive"}'
     # Expect HTTP 201 + `{ "ok": true, "requestId": "<ID>", "queuePosition": 1 }`
     ```
   - Windows PowerShell:
     ```powershell
     $headers = @{ "Content-Type" = "application/json"; Authorization = "Bearer $env:PUSHPALS_AUTH_TOKEN" }
     $body = '{"sessionId":"dev","prompt":"List repo packages","priority":"interactive"}'
     $resp = Invoke-WebRequest -Uri "http://localhost:3001/requests/enqueue" -Method Post -Headers $headers -Body $body
     $resp.StatusCode # Expect 201
     $resp.Content    # Contains ok=true + requestId
     ```
2. **Confirm RemoteBuddy claims it**
   - Observe the RemoteBuddy terminal (started via `bun run remotebuddy` from repo root). Within ~1s expect:
     - `[RemoteBuddy] claim payload: { ... "request": { "id": "<ID>" } }`
     - `[RemoteBuddy] Claimed request <ID>`
   - Manual API fallback if RemoteBuddy is stopped:
     ```bash
     curl -sS -X POST http://localhost:3001/requests/claim \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
       -d '{"agentId":"smoke-check"}'
     # Expect HTTP 200 + payload containing the queued request
     ```
3. **Check queue status transitions**
   ```bash
   curl -sS "http://localhost:3001/requests?status=claimed&limit=5" \
     -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" | jq '.requests[0].status'
   # Expect "claimed" with agentId="remotebuddy"

   curl -sS "http://localhost:3001/requests?status=completed&limit=5" \
     -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" | jq '.requests[].durationMs'
   # Expect the same requestId listed with durationMs populated once planning completes
   ```
4. **Inspect overall runtime health**
   ```bash
   curl -sS "http://localhost:3001/system/status" \
     -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" | jq '{pending: .queues.requests.pending, jobQueue: .jobPendingSnapshot}'
   # Expect `pending: 0` after the smoke item clears; jobQueue is empty unless RemoteBuddy enqueued WorkerPal jobs
   ```

For a fully automated round-trip (Client → LocalBuddy → RemoteBuddy → WorkerPals), keep `server`, `localbuddy`, and `workerpals` running, then execute `PUSHPALS_AUTH_TOKEN=<token> bun run smoke` from the repo root. That script asserts the presence of `task_created` and terminal events, complementing the manual enqueue/claim/status checks above.
