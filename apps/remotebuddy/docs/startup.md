# RemoteBuddy Startup Preflight Runbook

_Last updated: 27 Feb 2026 -- applies to RemoteBuddy v2026.02 train._

Run this playbook whenever you cold-start a RemoteBuddy stack (fresh host, CI boot, or recovering
from a full outage). It sequences the dependent services, captures the telemetry gates that must be
green before admitting traffic, and lists the verification plus rollback actions that keep startup
safe and auditable.

## Deterministic preflight workflow

Run the Bun preflight guard before you spin up RemoteBuddy or hand traffic to it. The command emits
newline-delimited JSON (one object per check) plus readable log lines so both humans and
automation can consume the results.

```bash
cd apps/remotebuddy
bun run preflight [--json] [--allow-dirty] [--allow-missing-auth]
```

- `--json` suppresses the human-readable log lines and prints JSON only.
- `--allow-dirty` lets you bypass the dirty worktree guard (the output still notes the bypass).
- `--allow-missing-auth` is only for open Server deployments; otherwise, export `PUSHPALS_AUTH_TOKEN`.

RemoteBuddy’s supervisor (`bun run remotebuddy:only`) now runs the same guard automatically and
refuses to start if any check fails. Operators should therefore run the standalone command first so
they can remediate issues without restarting RemoteBuddy repeatedly.

### Failure codes surfaced by `bun run preflight`

| Code | Meaning | Remediation |
| --- | --- | --- |
| `remotebuddy.config_missing` | `configs/default.toml` or `configs/local.toml` is missing/empty. | Copy `configs/local.example.toml` to `configs/local.toml`, keep both configs readable, then rerun. |
| `remotebuddy.config_invalid` | TOML/env parsing failed (syntax errors, bad values). | Fix the parse error reported in the detail field, usually by correcting TOML syntax. |
| `remotebuddy.secrets_missing` | `PUSHPALS_AUTH_TOKEN` (and therefore Server auth) is absent. | Export the token in `.env`/shell or run with `--allow-missing-auth` only if the Server is intentionally open. |
| `remotebuddy.merge_in_progress` | Git merge/rebase detected in the repo root. | Resolve/abort the merge before dispatching jobs so RemoteBuddy reads a stable tree. |
| `remotebuddy.workspace_dirty` | Uncommitted files found. | Commit/stash/drop the files or rerun with `--allow-dirty` for explicitly blessed diffs. |
| `remotebuddy.server_unreachable` | `GET /system/status` failed or timed out. | Start Server via `bun run server:only`, confirm the auth token, and verify `/healthz` before retrying. |
| `remotebuddy.workerpals_capacity_blocked` | Worker idle slots < 1 or queue depth > 15. | Launch/scale WorkerPals lanes until idle slots recover and queues drain. |
| `remotebuddy.unknown_preflight_failure` | Supervisor blocked before a check produced failure metadata (usually due to a crash or unexpected exception). | Rerun `bun run preflight --json`, capture the stderr leading up to the crash, and fix the top-level error before restarting RemoteBuddy. |

Every telemetry line includes `code`, `category`, `step`, `status`, `detail`, and `action`, so it’s
easy to ship into log pipelines or attach directly to the on-call thread. Each supervisor run prints
per-check log lines that match the literal string `[RemoteBuddySupervisor] [preflight] PASS|FAIL …`
plus a single structured JSON event that looks like
`{"component":"RemoteBuddySupervisor","event":"preflight_result","status":"passed","record_count":7,...}`.
Automation should parse that JSON blob to read the `code`, `category`, `step`, `detail`, and
`action` fields surfaced back to the CLI.

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

## Dependency bring-up checklist

1. **Config + secrets**
   - `bun install` has been run at least once on the host; `node_modules` is present.
   - `configs/default.toml` and `configs/local.toml` match the intended train (`git status --short` is
     empty or only shows deliberate overrides).
   - Environment variables exported: `PUSHPALS_AUTH_TOKEN`, `REMOTE_STABLE_ID`, `WORKERPALS_API_URL`,
     `SERVER_BASE_URL`. Document redacted values in the ops log.
   - Run `bun run preflight` and attach its JSON output to the incident/on-call log. RemoteBuddy startup
     will not continue until this succeeds.
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
   - The supervisor blocks on the preflight guard; wait for `[RemoteBuddySupervisor] [preflight] PASS`
     logs to finish before expecting RemoteBuddy to spawn.
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
