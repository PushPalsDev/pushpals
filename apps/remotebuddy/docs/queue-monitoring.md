# RemoteBuddy Queue Monitoring Expectations (`queue.monitoring`)

_Last updated: 25 February 2026 — codifies the live signals, alert thresholds, and remediation flow everyone on RemoteBuddy Platform must follow._

Use this doc when you are staring at Grafana, Alertmanager, or `/system/status` and need a quick reference for what "healthy" means, when to page, and what to try first. Pair it with `queue.md` (broader guidance) and `queue-health.md` (restart-focused runbook) for deeper detail.

## Core Metrics to Track Every 5 Minutes

| Metric                                               | Healthy Range                        | Surface / How to Pull                                                                               | Why it matters                                                                                                 |
| ---------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `queue_p95` (RemoteBuddy request queue wait)         | 0.7 s–0.9 s baseline, ≤1.0 s SLO     | Grafana › RemoteBuddy Queue Overview (`queue_p95` panel), `/system/status.slo.requests.queueWaitMs` | Primary SLO indicator; rising trends hint at worker starvation or upstream slowness.                           |
| Interactive backlog (`requests.pending.interactive`) | < 40 requests, ≤2 min oldest request | Grafana backlog panel, `/system/status.queues.requestPendingSnapshot.interactive`                   | Direct impact on user-facing latency; determines when to throttle background lanes.                            |
| Background/eval backlog                              | < 80 combined, ≤5 min oldest         | Same panel + API snapshot                                                                           | Swells silently; pausing these lanes protects interactive work.                                                |
| Job queue depth (`queues.jobPendingSnapshot`)        | Spikes cleared in < 3 min            | `/system/status` (job snapshot), WorkerPals Ops board                                               | Detects job stuck loops or scheduling gaps even when request backlog looks normal.                             |
| Worker idle slots per lane                           | ≥3 interactive, ≥1 background        | `/workers`, WorkerPals dashboard, worker logs                                                       | Ensures the planner can immediately claim work; anything lower means add capacity or investigate hung workers. |
| Worker error rate (`job_failure_rate`)               | ≤0.2 sustained                       | Grafana › WorkerPals Job Outcomes (`job_failure_rate` panel)                                        | Rising failures reduce effective capacity and precede queue inflation.                                         |

Always capture Grafana + `/system/status` snapshots before intervening so you can prove whether actions helped and so later handoffs stay grounded in data.

## Alert Thresholds and Expectations

| Signal                      | Warning channel / trigger                                                      | Paging trigger                                                                 | Immediate expectation                                                             |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `queue_p95` (15 min rollup) | ≥1.5 s for 2 min → Grafana `queue_p95_spike_warning` posts in `#pushpals-ops`. | ≥2.0 s for 5 min → PagerDuty **RemoteBuddy Platform** incident + Slack mirror. | Acknowledge ≤5 min, post status thread, begin remediation workflow below.         |
| Interactive backlog         | >40 requests for 3 polls → Slack reminder.                                     | >60 requests or any request >10 min old → PagerDuty page.                      | Throttle/stop background submissions immediately, note ticket IDs deferred.       |
| Worker idle slots           | <2 idle workers per lane for 3 polls → Slack ping `@workerpals-oc`.            | ≤1 idle worker overall for 5 min → WorkerPals Runtime page.                    | Launch additional WorkerPals pools or restart hung workers.                       |
| `job_failure_rate`          | ≥0.3 for 5 min → Grafana note in `#pushpals-ops`.                              | ≥0.4 → WorkerPals Runtime secondary page.                                      | Capture failing job IDs/logs and prep restarts before retriggering queue traffic. |

- **Acknowledgement discipline:** All alerts hitting `#pushpals-ops` get an acknowledgement emoji + thread reply within 5 minutes. Paging alerts require PagerDuty ack and a thread status post (timestamp, owner, next update time).
- **Escalation ladder:** RemoteBuddy Platform → WorkerPals Runtime → Reliability Lead. Use `/pd escalate` if remediation stalls or queue_p95 ≥2.0 s for >10 minutes after initial actions.

## Troubleshooting + Remediation Workflow

1. **Validate telemetry** (0–3 min)
   - Refresh Grafana (Queue Overview + Worker Backends) and `/system/status`. Pin screenshots + JSON in the alert thread.
   - Confirm idle worker counts and backlog per lane; avoid acting on stale points.
2. **Stabilize demand** (3–5 min)
   - Pause or throttle background/eval submissions via LocalBuddy Admin or `throttle set background hard`. Document when throttles start.
   - For interactive-only spikes, coordinate with product support before deferring any sessions.
3. **Recover capacity** (5–10 min)
   - Launch/scale WorkerPals: `bun run workerpals:only[:docker]` until each lane regains ≥ documented idle slots.
   - Restart unhealthy workers or pods (`--drain` then relaunch) if logs show hung tasks or wrapper timeouts.
4. **Clear stuck jobs** (10–15 min)
   - Inspect `queues.jobPendingSnapshot` for items retrying >3 times; requeue or rebuild them.
   - Use `/requests/:id` admin PATCH to fail obsolete requests so fresh work can start.
5. **Check dependencies** (parallel while above runs)
   - Grafana Worker Backends latency: if upstream OpenAI/storage is slow, flip simple planners to `requires_worker=false` so critical jobs keep capacity.
   - Confirm server APIs (`bun run server:only -- --health`) respond within normal latency.
6. **Verify + document** (after metrics recover)
   - Ensure `queue_p95` ≤1.0 s, backlog within limits, worker idle restored. Post updated screenshots + `/system/status` excerpt.
   - Track everything in PagerDuty notes + Slack: what changed, when throttles lift, who owns any follow-up.

## Rapid Verification Checklist (Run Twice: immediately + 10 min later)

1. `queue_p95` ≤1.0 s, `job_failure_rate` ≤0.2, backlog per lane back under guardrails.
2. `/system/status` shows no pending interactive requests older than 2 minutes; `queues.jobPendingSnapshot` stable.
3. Worker logs are clean (no crash loops, wrapper timeouts) for two claim cycles.
4. Synthetic probe `probe.queue_lowload` stays <650 ms and no new autonomy `sig_queue_health` requests trigger.

If any check fails, repeat the remediation workflow from the relevant step (capacity, job clearing, dependency verification) and update the incident thread before closing alerts.
