# RemoteBuddy Queue Health (`task.execute`)

_Last updated: 25 February 2026 — describes the paging playbook for on-call engineers when `task.execute` queue health alerts fire._

Use this runbook when Alertmanager or Grafana reports `task.execute` degradation. It pairs with
`apps/remotebuddy/docs/queue.md` (monitoring) and `queue-playbook.md` (deep tuning) but keeps the
alert triggers, restart order, and verification checks for `task.execute` in one place.

## Alert Thresholds

| Trigger                                                                                | Metric + surface                                                                                                                                                                              | Immediate action                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `queue_p95` ≥ **1.5 s** for 5 minutes (interactive lane, 15 min rollup)                | Grafana › RemoteBuddy Queue Overview (`queue_p95` panel), `/system/status.slo.requests.queueWaitMs`                                                                                           | Page RemoteBuddy Platform, confirm autopause of background/eval submissions, prep restart steps below. |
| `job_failure_rate` ≥ **0.4** (failures / total `task.execute` jobs in last 10 minutes) | Grafana › WorkerPals Job Outcomes (`job_failure_rate` panel), PromQL `sum(rate(remote_jobs_failed_total{kind="task.execute"}[10m])) / sum(rate(remote_jobs_total{kind="task.execute"}[10m]))` | Page WorkerPals Runtime secondary, capture most recent WorkerPals logs, then run the restart flow.     |

Treat either condition as a full queue-health incident. Always acknowledge alerts in `#pushpals-ops`
within 5 minutes and start the steps below before experimenting with additional levers.

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
      pool). Launch at least the documented minimum idle workers per lane (≥3 interactive, ≥1 background).
5. **Re-enable traffic carefully:** Resume background/eval submissions in 5-job batches only after
   `queue_p95` < 1.0 s and `job_failure_rate` < 0.2 for two consecutive polls.
6. **Document:** Post restart timestamps, commands, hostnames, and any anomalies (crash loops, schema
   mismatches) in the PagerDuty incident + Slack thread.

## Verification Checks

Run these immediately after restarts and again 10 minutes later:

1. **Metrics back to green:** `queue_p95` ≤ 1.0 s, `job_failure_rate` ≤ 0.2, worker idle ≥ 3 per lane;
   attach new Grafana snapshots to the thread.
2. **WorkerPals log sweep:** No `task.execute` wrapper timeouts or crash loops for at least two claim
   cycles; confirm `workerpals:only -- --tail` stays quiet aside from normal heartbeats.
3. **Request sanity:** `curl -sS /system/status \| jq '{queue_p95: .slo.requests.queueWaitMs, pending: .queues.requests, jobs: .queues.jobPendingSnapshot}'`
   shows pending interactive < 10 and zero zombie jobs; sample `/requests?status=pending&limit=5` to
   ensure `createdAt` timestamps are < 2 minutes old.
4. **Synthetic probe + autonomy review:** Ensure `probe.queue_lowload` < 650 ms and no new
   `sig_queue_health` autonomy requests fired after the restart; close any remaining alerts only after
   these probes stay healthy for 10 minutes.

If any check fails, loop back to the restart step that applies (workers, remotebuddy, or server) and
repeat verification before resuming background traffic.
