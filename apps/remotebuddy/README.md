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

## Prerequisites & Cross-Platform Install Commands

RemoteBuddy reuses the repo-wide toolchain (Bun + `.env`). Install these before running the service.

1. **Bun 1.x**
   - macOS (zsh/bash):
     ```bash
     curl -fsSL https://bun.sh/install | bash
     ```
   - Linux (bash):
     ```bash
     curl -fsSL https://bun.sh/install | bash
     ```
   - Windows PowerShell (native):
     ```powershell
     irm https://bun.sh/install.ps1 | iex
     ```
2. **Install workspace dependencies (prevents `ENOENT ... node_modules/shared`)**
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
3. **Seed local config**
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
4. **`jq` for status checks (`curl ... | jq`)**
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

## Commands & Working Directories

### Repo-root scripts (validated against `package.json`)

| Use case | Run from repo root | Script body | Working directory during execution |
| --- | --- | --- | --- |
| Build protocol + start RemoteBuddy (recommended path) | `bun run remotebuddy` | `protocol:build` → `remotebuddy:only` | Root during build, then `apps/remotebuddy` via `--cwd` |
| Start RemoteBuddy with `.env` wiring only | `bun run remotebuddy:only` | `bun --cwd apps/remotebuddy --env-file ../../.env start` | `apps/remotebuddy` |
| Hot reload/watch mode | `bun run remotebuddy:only:watch` | `bun --cwd apps/remotebuddy --env-file ../../.env dev` | `apps/remotebuddy` |

> Tip: Keep `bun run server:only` running in another terminal so the claim/complete round-trip works.

### App-local scripts (`cd apps/remotebuddy` first)

| Command | Working directory | Description |
| --- | --- | --- |
| `bun run start` | `apps/remotebuddy` | Runs `src/remotebuddy_main.ts` once (root `remotebuddy:only` delegates here). |
| `bun run dev` | `apps/remotebuddy` | `bun --watch --no-clear-screen src/remotebuddy_main.ts` for rapid iteration. |

### Direct CLI invocation

```bash
cd apps/remotebuddy
bun run src/remotebuddy_main.ts \
  --server ${PUSHPALS_SERVER_URL:-http://localhost:3001} \
  --sessionId ${PUSHPALS_SESSION_ID:-dev} \
  --token ${PUSHPALS_AUTH_TOKEN:-<optional>}
```

- Runtime precedence is `CLI flag > env vars (PUSHPALS_SERVER_URL/PUSHPALS_URL, PUSHPALS_SESSION_ID, PUSHPALS_AUTH_TOKEN/AUTH_TOKEN) > config defaults`.
- `--sessionId ""` (or `PUSHPALS_SESSION_ID=""`) requests a brand-new session; blank CLI tokens are rejected (`--token` must be omitted to run without auth).
- Setting `PUSHPALS_AUTH_TOKEN=""` or `AUTH_TOKEN=""` clears a previously configured token (useful when falling back to unauthenticated local stacks).
- Use `--token <value>` for auth (the legacy `--authToken` alias is still accepted for backward compatibility).
- `--server` must receive a non-empty value. Any unexpected positional argument before `--` throws (`bun run ... -- --foo` preserves downstream args).
- Arguments after `--` are preserved for downstream tooling; RemoteBuddy logs them but leaves interpretation to the consumer.
- Env/CLI values are trimmed before parsing so stray whitespace does not affect detection.
- When no CLI flag or env var supplies a token, RemoteBuddy runs without auth headers (only acceptable for unsecured local stacks).

## Token Acquisition & Verification Flow

RemoteBuddy and Server share the same bearer token (`PUSHPALS_AUTH_TOKEN`). The token gates every `requests/*` and `jobs/*` endpoint once configured.

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

## Runtime Smoke-Test Checklist (beyond lint)

> All curl/PowerShell examples assume a tokenized server; omit the header if you are running open access.

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
