# RemoteBuddy Startup Preflight Runbook

_Last updated: 27 Feb 2026 -- applies to RemoteBuddy v2026.02 train._

Run this playbook whenever you cold-start a RemoteBuddy stack (fresh host, CI boot, or recovering
from a full outage). It sequences the dependent services, captures the telemetry gates that must be
green before admitting traffic, and lists the verification plus rollback actions that keep startup
safe and auditable.

## When to run this check

- Any time you restart `bun run remotebuddy:only` outside a rolling deploy.
- After rotating secrets or upgrading WorkerPals/Server components that RemoteBuddy depends on.
- Following hardware or container migrations where persistent config may differ.
- When a previous startup failed and you need the exact evidence to prove the stack is healthy.

## High-level flow (15 minute target)

| Minute | Owner | Action | Evidence to capture |
| --- | --- | --- | --- |
| 0 | Platform on-call | Confirm repo state + config parity (`git status`, `config/*.toml`). | Screenshot or paste of clean diff summary. |
| 2 | Server on-call | Start Server (Terminal A) and WorkerPals (Terminal B) in their dedicated, `.env`-sourced shells; watch `/system/status`. | `curl .../system/status` JSON snippet with worker idle counts. |
| 5 | RemoteBuddy on-call | Launch RemoteBuddy from Terminal D (shell already sourced `.env`) and keep the logs streaming. | Process log tail sent to `#pushpals-ops`. |
| 7 | Platform on-call | Perform telemetry gates (table below). | Grafana snapshot + Alertmanager screenshot. |
| 10 | RemoteBuddy on-call | Run verification RPC + synthetic end-to-end request. | `request_id` link + resulting transcript. |
| 13 | Platform on-call | Announce green state or rollback trigger with explicit timestamps. | Thread update referencing evidence artifacts. |

Always attach the captured evidence to your PagerDuty incident or the on-call log so the next
startup can reference a single source of truth.

## Canonical environment + terminal prerequisites

RemoteBuddy inherits the canonical env set defined in [apps/remotebuddy/README.md » Canonical Environment Variables](../README.md#canonical-environment-variables). Before touching services:

- Ensure `.env` exports `PUSHPALS_SERVER_URL`, `PUSHPALS_SESSION_ID`, `PUSHPALS_PROFILE`, and `PUSHPALS_AUTH_TOKEN` (required whenever Server auth is enabled). Re-use the presence-only snippet from the README so you only see `=present`/`missing` instead of raw secrets.
- Confirm `.env` and `config/local.toml` were copied from their `*.example` templates and match the target train.
- For every shell or tmux pane you plan to keep running, immediately run the README “Load the canonical env set once per terminal” snippet so the `.env` values are exported. From this point on you should never prefix commands with inline secrets.
- Open separate terminals or tmux panes that will stay dedicated (and in this bring-up order) for the rest of the runbook: **Terminal A** – Server, **Terminal B** – WorkerPals, **Terminal C** – LocalBuddy (optional but recommended for ingress validation), **Terminal D** – RemoteBuddy/log tails. Leave each window running in parallel; do not recycle them for sequential commands.

| Terminal | Role | Command to keep running | Bring-up order |
| --- | --- | --- | --- |
| A | Server API + queues | `bun run server:only` | Start immediately after Pre-work passes. |
| B | WorkerPals capacity | `bun run workerpals:only -- --lanes interactive=4,normal=2,background=1` | Start after Terminal A reports healthy. |
| C (optional) | LocalBuddy ingress validation | `bun run localbuddy:only` | Start after WorkerPals so ingress checks see a healthy queue. |
| D | RemoteBuddy orchestrator + log tail | `bun run remotebuddy:only` | Start last; only after Terminals A–C are stable. |

Only proceed when the env snippet shows every always-required variable as `present`, and (if Server auth is enabled) when `PUSHPALS_AUTH_TOKEN=present`.

## Dependency bring-up checklist

Complete steps 1–2 **before** launching any daemons; they install dependencies and seed config. Steps 3–6 map directly to Terminals A–D in the table above—bring them up in order and keep each shell open so the services stay online in parallel. Each terminal should already have `.env` loaded via the README snippet before running the commands below, and you should not progress to the next terminal until the current one passes its health checks.

### Pre-work (shared terminal)

1. **Repo sync + dependencies**
   - Run `git fetch origin && git status --short` to confirm only intentional diffs exist.
   - Execute `bun install` from the repo root; rerun whenever `bun.lock` or `package.json` changes.
   - Copy `.env.example → .env` and `config/local.example.toml → config/local.toml` when they do not exist.
2. **Canonical env + config sanity**
   - In the shared terminal run the `.env` loading snippet from the README to export every `PUSHPALS_*` value (rerun if `.env` changes).
   - Re-run the presence-only snippet from the README and paste the `=present`/`missing` output into the ops log (do not log raw values).
   - Confirm `config/default.toml` plus `config/local.toml` match the intended train (no unexpected `git status` noise).

### Dedicated terminals (parallel daemons)

3. **Terminal A – Server**
   - Long-running command: `bun run server:only` (leave this terminal running for the duration of the preflight).
   - Health: `curl -sf http://localhost:3001/healthz` returns `ok` within 2 seconds.
   - Metrics: `/system/status` shows `queues.requests.pending` ≤ 5 per lane.
4. **Terminal B – WorkerPals**
   - Long-running command: `bun run workerpals:only -- --lanes interactive=4,normal=2,background=1` (keep the pane open so WorkerPals stay online).
   - Confirm `worker_idle_slots` ≥ 3 per lane for two consecutive polls.
   - Watch Worker Backends Latency dashboard for RPC spikes.
5. **Terminal C – LocalBuddy (optional ingress verification)**
   - Long-running command: `bun run localbuddy:only` (dedicated window; keep it attached so ingress checks remain active).
   - Use the Ops tab or `/requests/status` endpoints to confirm LocalBuddy detects the active RemoteBuddy instance before resuming paid traffic.
6. **Terminal D – RemoteBuddy**
   - Long-running command: `bun run remotebuddy:only` (this pane doubles as the primary log tail).
   - Verify the bootstrap log prints `planner ready` and `worker lease acquired` within 90 seconds.
   - Keep this terminal open for log tailing throughout the remaining verification steps.

## Telemetry gates (block startup if any fail)

| Signal | Pass criteria | Source or command | Rollback / block trigger |
| --- | --- | --- | --- |
| Remote queue latency `queue_p95` (interactive, 5 min) | ≤ 0.65 s while traffic ≤ 35 RPS. | Grafana › RemoteBuddy Queue Overview › `queue_p95`. | ≥ 0.8 s for 5 min or upward trend immediately after RemoteBuddy launch. Roll back to previous build or pause RemoteBuddy start. |
| Pending interactive requests | < 10 steady; zero monotonic growth. | `/system/status` → `queues.requests.pending`. | ≥ 15 pending with flat traffic: stop RemoteBuddy and re-check WorkerPals allocation. |
| Worker idle slots | ≥ 3 per lane; no `busy` workers > queue budget. | Worker Backends Latency dashboard + `/system/status.workers`. | ≤ 1 idle slot for 3 polls: tear down RemoteBuddy, scale WorkerPals up, retry. |
| Synthetic probe `probe.remote_startup` | < 700 ms, 0 drops in 10 samples. | Grafana › Synthetic Probes › `probe.remote_startup`. | ≥ 850 ms or probe failures: roll back RemoteBuddy or mute traffic sources. |
| Alertmanager `remote-*` group | No active warning/page alerts. | Alertmanager quick view filtered by `remote`. | Any warning still firing after dependency start: block startup until cleared. |

Record each check with timestamp, screenshot link, and the PromQL/command you used. Without stored
evidence the preflight is considered incomplete.

## Verification steps before declaring success

1. **API smoke test**
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
     -H "Content-Type: application/json" \
     http://localhost:3001/requests/enqueue \
     -d '{"prompt":"startup smoke","priority":"interactive","metadata":{"source":"startup-preflight"}}'
   ```
   - Confirm response includes `requestId`.
   - Watch RemoteBuddy logs for the matching ID finishing with status `completed`.
2. **Planner loop check**
   - Tail the RemoteBuddy logs you captured during launch (for example,
     `tail -f /tmp/remotebuddy.log | grep <requestId>`) while the
     smoke test executes.
   - Success criteria: log shows `PlannerOutput intent=interactive lane=worker`, followed by
     `worker lease acquired` and `request completed`.
3. **Synthetic deterministic lane check**
   - Use `/system/status` to verify deterministic lane latency ≤ 200 ms if deterministic overrides are
     enabled.
4. **Client-surface verification**
   - Load the Ops dashboard and ensure ETA overlays show the new pod plus no stuck jobs.
   - Post a screenshot in `#pushpals-ops` with the timestamped verifying job.

Only after all four verifications pass may you switch background/evaluation job intake from paused to
normal.

## Rollback triggers and actions

Trigger any of the actions below and immediately follow the recorded rollback procedure (same as in
`apps/remotebuddy/docs/queue-playbook.md`):

- Telemetry gate fails for two consecutive polls (≈5 minutes) after RemoteBuddy launch.
- Startup logs show `worker lease lost` or `planner panic` twice in 10 minutes.
- `/system/status` pending counts grow ≥ 20 despite idle slots being ≥ 5 (indicates logic regressions).
- Synthetic probe uptime < 95% over the first 15 minutes of traffic.
- Alertmanager escalates (`remote_startup_page` or `worker_idle_global_page`) before verification ends.

**Rollback steps (summarized)**

1. `git status` → snapshot current diffs; stash if necessary.
2. Stop RemoteBuddy (`Ctrl+C`) plus WorkerPals lanes you started for this attempt.
3. `git checkout <last-good-tag> -- config/default.toml config/local.toml` (or reapply the saved copies).
4. Restart Server and WorkerPals using the known-good command set.
5. Re-run telemetry gates; keep RemoteBuddy offline until every signal is green for one full interval.

Document the exact trigger, timestamp, and commands in the incident thread so when you retry the
startup you can prove the rollback completed successfully.

## Post-start reminders

- Backfill the ops journal entry with links to Grafana snapshots, Alertmanager cards, `/system/status`
  JSON, RemoteBuddy log excerpts, and the verification request ID.
- Set a reminder (next business day 17:00 PT) to confirm telemetry stayed inside the pass criteria.
- File any follow-up issues (config drift, flaky probes) before ending your on-call shift.
