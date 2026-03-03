# RemoteBuddy Startup Preflight Runbook

_Last updated: 27 Feb 2026 -- applies to RemoteBuddy v2026.02 train._

Run this playbook whenever you cold-start a RemoteBuddy stack (fresh host, CI boot, or recovering
from a full outage). It sequences the dependent services, captures the telemetry gates that must be
green before admitting traffic, and lists the verification plus rollback actions that keep startup
safe and auditable.

## Running the automated preflight

- Execute `bun run preflight` from the repo root to run the same startup checks (env-file precedence, Bun version, auth variables) without launching long-lived services.
- Pass `--json` for machine-readable output, or rely on the default human-readable summary for manual bring-up.
- Override the env file by setting `REMOTEBUDDY_PREFLIGHT_ENV_FILE=/path/to/.env` when you need to test a specific configuration snapshot.

## When to run this check

- Any time you restart `bun run remotebuddy:only` outside a rolling deploy.
- After rotating secrets or upgrading WorkerPals/Server components that RemoteBuddy depends on.
- Following hardware or container migrations where persistent config may differ.
- When a previous startup failed and you need the exact evidence to prove the stack is healthy.

## High-level flow (15 minute target)

| Minute | Owner | Action | Evidence to capture |
| --- | --- | --- | --- |
| 0 | Platform on-call | Confirm repo state + config parity (`git status`, `configs/*.toml`). | Screenshot or paste of clean diff summary. |
| 2 | Server on-call | Start Server + WorkerPals lanes; watch `/system/status`. | `curl .../system/status` JSON snippet with worker idle counts. |
| 5 | RemoteBuddy on-call | Launch RemoteBuddy process with `PUSHPALS_AUTH_TOKEN` loaded. | Process log tail sent to `#pushpals-ops`. |
| 7 | Platform on-call | Perform telemetry gates (table below). | Grafana snapshot + Alertmanager screenshot. |
| 10 | RemoteBuddy on-call | Run verification RPC + synthetic end-to-end request. | `request_id` link + resulting transcript. |
| 13 | Platform on-call | Announce green state or rollback trigger with explicit timestamps. | Thread update referencing evidence artifacts. |

Always attach the captured evidence to your PagerDuty incident or the on-call log so the next
startup can reference a single source of truth.

## Preflight CLI quick reference

- Run `bun run remotebuddy:preflight` from the repo root to execute the deterministic repo/alerts/synthetic checklist.
- Pass `--json` when you need structured output for CI/bots.
- `REMOTEBUDDY_PREFLIGHT_ENV_FILE` (absolute path or repo-relative) controls which env file gets loaded before the checks; when unset the script falls back to `.env`.
- Set `REMOTEBUDDY_PREFLIGHT_SYNTHETIC_MODE=mock` if the Server stack is offline but you still need to verify repo/Alertmanager state.
- Provide comma-separated or JSON alert names via `REMOTEBUDDY_PREFLIGHT_ALERTS` to simulate Alertmanager failures during drills.

## Dependency bring-up checklist

1. **Config + secrets**
   - `bun install` has been run at least once on the host; `node_modules` is present.
   - `configs/default.toml` and `configs/local.toml` match the intended train (`git status --short` is
     empty or only shows deliberate overrides).
   - Environment variables exported: `PUSHPALS_AUTH_TOKEN`, `REMOTE_STABLE_ID`, `WORKERPALS_API_URL`,
     `SERVER_BASE_URL`. Document redacted values in the ops log.
2. **Server**
   - Command: `PUSHPALS_AUTH_TOKEN=... bun run server:only --env-file .env`.
   - Health: `curl -sf http://localhost:3001/healthz` returns `ok` within 2 seconds.
   - Metrics: `/system/status` shows `queues.requests.pending` ≤ 5 per lane.
3. **WorkerPals**
   - Command: `PUSHPALS_AUTH_TOKEN=... bun run workerpals:only -- --lanes interactive=4,normal=2,background=1`.
   - Confirm `worker_idle_slots` ≥ 3 per lane for two consecutive polls.
   - Watch Worker Backends Latency dashboard for RPC spikes.
4. **RemoteBuddy**
   - Command: `PUSHPALS_AUTH_TOKEN=... bun run remotebuddy:only`.
   - Verify the bootstrap log prints `planner ready` and `worker lease acquired` within 90 seconds.
5. **Optional LocalBuddy / client probes**
   - If this host also serves LocalBuddy traffic, start `bun run client:only` and open the Ops tab to
     confirm it sees the new RemoteBuddy instance before accepting paid tasks.

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
3. `git checkout <last-good-tag> -- configs/default.toml configs/local.toml` (or reapply the saved copies).
4. Restart Server and WorkerPals using the known-good command set.
5. Re-run telemetry gates; keep RemoteBuddy offline until every signal is green for one full interval.

Document the exact trigger, timestamp, and commands in the incident thread so when you retry the
startup you can prove the rollback completed successfully.

## Post-start reminders

- Backfill the ops journal entry with links to Grafana snapshots, Alertmanager cards, `/system/status`
  JSON, RemoteBuddy log excerpts, and the verification request ID.
- Set a reminder (next business day 17:00 PT) to confirm telemetry stayed inside the pass criteria.
- File any follow-up issues (config drift, flaky probes) before ending your on-call shift.
