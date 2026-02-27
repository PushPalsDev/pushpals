# RemoteBuddy Queue Health (`task.execute`)

_Last updated: 25 February 2026 — describes the paging playbook for on-call engineers when `task.execute` queue health alerts fire._

Use this runbook when Alertmanager or Grafana reports `task.execute` degradation. It pairs with
`apps/remotebuddy/docs/queue.md` (monitoring) and `queue-playbook.md` (deep tuning) but keeps the
alert triggers, restart order, and verification checks for `task.execute` in one place.

## Canonical queue + idle guardrails

Copied verbatim from `apps/remotebuddy/README.md`. Update this block first if the guardrails change; every other queue doc references it.

<!-- QUEUE_GUARDRAILS_TABLE:start -->
| Band | Conditions (observed via `/system/status`) | Operator action |
| --- | --- | --- |
| **Healthy** | `queue_p95` ≤ 1.0 s, pending interactive < 10, and idle workers ≥ 6 total (≈ 2 per lane via `.workers.idle`). | Keep `/system/status` tailing hourly; capture baseline snapshots once per shift. |
| **Warning** | `queue_p95` 1.0–1.5 s for ≥ 3 polls, or pending interactive ≥ 15 for ≥ 3 polls, or idle workers < 6 total for 3 polls. | Trigger queue-playbook diagnostics, pause background/eval submissions, and confirm queue automation already injected remediation jobs. |
| **Degradation** | `queue_p95` ≥ 1.5 s for ≥ 5 min, or pending interactive ≥ 30, or queue depth > 60 while idle workers stay < 6 total. | Announce in `#pushpals-ops`, throttle enqueueing to interactive-only, add WorkerPal capacity until idle ≥ 6 total again, and watch `jobPendingSnapshot` for stalls. |
| **Incident** | `queue_p95` ≥ 2.0 s, or queue depth > 60 for 5 polls, or idle workers < 6 total for 5 polls. | Page RemoteBuddy Platform + WorkerPals Runtime, freeze background traffic, and post 15 min updates until `queue_p95` < 1.0 s and idle ≥ 6 total for two consecutive polls. |
<!-- QUEUE_GUARDRAILS_TABLE:end -->

Job failure overlays stay unchanged: treat `job_failure_rate` ≥ **0.25** (rolling 10 min)
as warning data for diagnostics and ≥ **0.40** as a WorkerPals Runtime page. Combine the
failure rate with the queue table above when prioritizing mitigations.

Treat any entry outside the Healthy row as an incident-in-progress. Always acknowledge alerts
in `#pushpals-ops` within 5 minutes and start the steps below before experimenting with
additional levers.

## On-Call Restart Steps

1. **Freeze the queue:** Pause background/eval submissions (LocalBuddy Admin throttle) and note
   job IDs waiting longer than their queue budget; confirm interactive users keep priority.
2. **Snapshot telemetry:** Collect `/system/status` (queue wait, pending per lane, idle workers) and
   Grafana links for `queue_p95`, `job_failure_rate`, and Worker Backends latency. Pin both in the
   incident thread.
3. **Drain active workers gracefully:**
   - `bun run workerpals:only -- --drain` (or `workerpals:only:docker`) to stop new `task.execute`
     claims while letting in-flight jobs finish.
   - Watch `/workers` until all lanes show idle > 0 and `runningTasks` drops to zero.
4. **Restart components in order:**
   1. `bun run server:only --env-file .env` (ensures job APIs are healthy) — keep logs in `/tmp/server.log`.
   2. `bun run remotebuddy:only` (reseats planner + autonomous engine, rebuilds queue health state).
   3. Restart WorkerPals pool: `bun run workerpals:only` (or `workerpals:only:docker` for the shared
      pool). Launch enough capacity for `/system/status` to show ≥ 6 idle workers total (≈ 2 per lane; guardrail target).
5. **Re-enable traffic carefully:** Resume background/eval submissions in 5-job batches only after
   `queue_p95` < 1.0 s and `job_failure_rate` < 0.2 for two consecutive polls.
6. **Document:** Post restart timestamps, commands, hostnames, and any anomalies (crash loops, schema
   mismatches) in the PagerDuty incident + Slack thread.

## Verification Checks

Run these immediately after restarts and again 10 minutes later:

1. **Metrics back to green:** `queue_p95` ≤ 1.0 s, `job_failure_rate` ≤ 0.2, worker idle ≥ 6 total (≈ 2 per lane);
   attach new Grafana snapshots to the thread.
2. **WorkerPals log sweep:** No `task.execute` wrapper timeouts or crash loops for at least two claim
   cycles; confirm `workerpals:only -- --tail` stays quiet aside from normal heartbeats.
3. **Request sanity:** `curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" $SERVER/system/status \| jq '{queue_p95: .slo.requests.queueWaitMs.p95, pendingInteractive: .queues.requestPriorities.interactive, jobPendingSnapshot: .queues.jobPendingSnapshot, idleWorkers: .workers.idle}'`
   shows `pendingInteractive` < 10 and zero zombie jobs; sample `/requests?status=pending&limit=5` to
   ensure `createdAt` timestamps are < 2 minutes old.
4. **Synthetic probe + autonomy review:** Ensure `probe.queue_lowload` < 650 ms and no new
   `sig_queue_health` autonomy requests fired after the restart; close any remaining alerts only after
   these probes stay healthy for 10 minutes.

If any check fails, loop back to the restart step that applies (workers, remotebuddy, or server) and
repeat verification before resuming background traffic.
