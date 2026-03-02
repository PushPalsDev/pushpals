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
4. Run `bun run preflight` (or `bun run remotebuddy:preflight`) to execute the startup checks and confirm your `.env`/auth variables before launching long-lived services. Append `--json` when you need parsable output for automation.
5. Run `bun run remotebuddy` from the repo root for the recommended entry point, or pick another command from [Usage Commands](#usage-commands) when you need a specific mode.
6. Validate the round trip with the [Runtime Smoke Test](#runtime-smoke-test) so you catch queue, auth, or worker issues before handling real traffic.

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
  cp configs/local.example.toml configs/local.toml
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

### Queue health monitoring & triage

- **Telemetry watchlist** – Keep `/system/status` tailing so you can see `slo.requests.queueWaitMs.p95` (aka `queue_p95`) alongside `queues.requests.pending`, and pin Grafana’s WorkerPals Job Outcomes panel for `job_failure_rate` (task.execute failures / total jobs in the last 10 minutes). Pair those with `sig_queue_health` logs so autonomous spikes are surfaced even when dashboards lag.
- **Alert thresholds** – Treat the table below as additive to the [queue-health doc](apps/remotebuddy/docs/queue-health.md); hit the warning column as soon as either signal drifts for ≥3 polls so you can stop background traffic before pages fire.

| Signal | Warning (self-triage) | Page-worthy | Immediate action |
| --- | --- | --- | --- |
| `queue_p95` | ≥ 1.0 s for 3 polls **or** pending interactive ≥ 15 | ≥ 1.5 s for 5 min **or** queue depth > 60 / < 2 idle workers for 5 polls | Freeze background/eval submissions, confirm automation injected remediation jobs, and add WorkerPal capacity until idle ≥ 2 per lane. |
| `job_failure_rate` | ≥ 0.25 rolling 10 min | ≥ 0.40 rolling 10 min | Pull the most recent WorkerPals logs, look for retry storms/regressions, and prep the worker restart flow if failure spikes persist. |

- **Fast load-spike detection tips** – Run `watch -n 5 curl -sS $SERVER/system/status | jq '{p95: .slo.requests.queueWaitMs.p95, pending: .queues.requests.pending, jobs: .queues.jobPendingSnapshot}'` during incidents so you catch >0.5 s jumps before alerts aggregate, and keep `tail -f logs/remotebuddy.log | rg sig_queue_health` open to spot remediation bursts. When `queue_p95` jumps ≥0.3 s between polls, immediately check `/requests?status=pending&limit=20` for aging interactive prompts and manually re-prioritize them.
- **Escalation steps** – 1) Announce the metric breach with snapshots in `#pushpals-ops`; 2) loop WorkerPals/Platform on-call if warning bands last >10 minutes or `job_failure_rate` crosses 0.4; 3) page Infrastructure/SRE if worker restarts do not clear the spike or shared services look unhealthy. Keep time-stamped updates every 15 minutes until `queue_p95` < 1.0 s and `job_failure_rate` < 0.2 for two consecutive polls.

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

| Condition (rolling 5 min) | Target behavior | Required action |
| --- | --- | --- |
| `queue_p95` ≤ 1.0 s and pending interactive < 10 | Healthy “≈0” wait time | No action; keep `/system/status` tailing hourly. |
| `queue_p95` 1.0–1.5 s or pending interactive ≥ 15 | Early warning | Trigger queue-playbook diagnostics, verify automation already injected remediation requests, and pause new background/eval submissions. |
| `queue_p95` ≥ 1.5 s for > 5 min **or** pending interactive ≥ 30 | Degradation | Announce in `#pushpals-ops`, throttle enqueueing to interactive-only, add WorkerPal capacity, and watch `jobPendingSnapshot` for stalled jobs. |
| `queue_p95` ≥ 2.0 s **or** queue depth > 60 **or** < 2 idle workers for 5 polls | Incident | Page platform on-call, hand over `/system/status` snapshot + worker logs, and keep posting updates every 15 min until p95 drops below 1.0 s. |

### Operator checkpoints (per rotation)

- `curl -sS /system/status` → confirm `queues.requests.pending`, `slo.requests.queueWaitMs`, and `jobPendingSnapshot` stay at/near zero; log anomalies in the ops doc.
- `curl -sS /requests?status=pending&limit=20` → ensure interactive requests have `createdAt` within the last minute; anything older gets re-queued or force-completed depending on owner feedback.
- `curl -sS /jobs?status=pending` + WorkerPals logs → verify no job kind is retrying > 3 times; reboot workers stuck `busy` without logs.
- `curl -sS /workers` → maintain ≥ 2 idle WorkerPals per lane; if automation hasn’t reached `maxWorkers`, start another `bun run workerpals` instance locally or in the pool.
- `apps/remotebuddy/docs/queue-playbook.md` → follow the mitigation checklist whenever any checkpoint crosses the warning threshold.

### On-call escalation path

1. **RemoteBuddy primary (24 × 7 rotation):** acknowledge dashboard/webhook alerts within 5 minutes, run the checkpoints above, and document steps in `#pushpals-ops`.
2. **WorkerPals/Platform secondary:** ping the platform on-call (same rotation as WorkerPals) if queue guardrails enter “Degradation” or “Incident” bands for >10 minutes, or if auto-spawn cannot reach ≥2 idle workers.
3. **Infrastructure/SRE tertiary:** escalate to infra on-call when degradation roots in shared services (LLM vendor, git, registry) or when queue automation repeatedly re-enqueues the same remediation instruction after operators intervene.
4. Keep a rolling incident log (timestamp, metric snapshot, corrective action) and attach it to the follow-up RCA if paging was required.

## On-Call Deployment Flow (Summary)

Use this path any time you need to redeploy RemoteBuddy because of a regression, host reboot, or planned change. The goal is to minimize queue downtime while keeping provenance crystal clear.

1. **Stabilize & communicate** – Post intent in `#pushpals-ops`, capture the latest `/system/status` snapshot, and pause new background/eval submissions if queue guardrails are already amber/red. Confirm another operator is watching WorkerPals capacity before you bounce RemoteBuddy.
2. **Sync repo + dependencies** – On the target host run `git fetch origin && git checkout <target-commit> && git pull --ff-only`. Compare `bun.lock`/`package.json`; if they changed, run `bun install`. Double-check `.env` and `configs/local.toml` still have the right `PUSHPALS_*` entries.
3. **Build protocol + start the process** – Prefer the repo-root script `bun run remotebuddy` (executes `protocol:build` first, then `remotebuddy:only`). When protocols are already current, `bun run remotebuddy:only` or `bun --cwd apps/remotebuddy run start` (enables `remotebuddy_supervisor.ts` restarts) keeps downtime minimal. Keep the existing terminal or tmux pane open so you can tail logs live.
4. **Validate the new instance** – Wait for `[RemoteBuddy] Starting polling loop…` followed by at least one `claim payload` log. Immediately hit `curl -sS $SERVER/system/status | jq '{queues: .queues.requests, jobs: .jobPendingSnapshot}'` and `curl -sS "$SERVER/requests?status=claimed&limit=5"`. Optionally run the smoke test in the section below (`bun run smoke`) or enqueue a single interactive request to prove round-trip health. Confirm `queue_p95`, worker idle counts, and the CommunicationManager WebSocket reconnect cleanly.
5. **Observe, rollback if needed** – Watch logs for 5–10 minutes. If failures persist, stop the process, `git checkout <last-known-good>`, rerun step 3, and move `remotebuddy-state.db` aside only when it is clearly corrupted (RemoteBuddy will recreate it, but previously-handled events may replay once). Document the outcome and handoff time in `#pushpals-ops`.

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

- `--server`, `--sessionId`, and `--token` override values loaded from `configs/*.toml` + `.env`.
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
