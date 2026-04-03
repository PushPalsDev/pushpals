# RemoteBuddy Queue Maintenance (`queue_p95`)

_Last updated: 24 February 2026 — baseline `queue_p95` = **0 ms** (rolling 24 h)._

RemoteBuddy’s live queue now idles at zero wait, so every alert, health check, and recovery
path in this doc assumes any measurable latency is abnormal. Keep the playbook scoped to
queue latency only; deeper debugging steps still live in `apps/remotebuddy/docs/queue-playbook.md`.

## Current Metrics

| Signal                         | Baseline expectation | Notes                                                                                                                      |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `queue_p95` (interactive lane) | 0 ms                 | Treat any >0 reading as regression; use Grafana “RemoteBuddy Queue Overview” side-by-side (last 15 m vs 24 h) to confirm.  |
| Pending interactive requests   | < 10                 | Healthy empty queue mirrors 0 ms wait. Rising backlog almost always precedes latency before alerts page.                   |
| Worker idle slots              | ≥ 3 per lane         | Maintains runway should automated enqueues (autonomy `forceWorker`) surge. Below this threshold run step 3 in the runbook. |

## Alert Thresholds

These thresholds align with the **guardrails for queue_p95 ≈ 0** published in README.

| Condition                                                                      | Alert surface                                             | Immediate action                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `queue_p95` ≤ 1.0 s **and** pending interactive < 10                           | Healthy (no alert)                                        | Keep `/system/status` tailing hourly; capture baseline snapshots once per shift.                                             |
| `queue_p95` 1.0–1.5 s **or** pending interactive ≥ 15                          | Slack `queue_p95_spike_warning` thread in `#pushpals-ops` | Run diagnostics in queue-playbook, verify automation injected `forceWorker` requests, pause new eval/background submissions. |
| `queue_p95` ≥ 1.5 s for >5 m **or** pending interactive ≥ 30                   | PagerDuty: RemoteBuddy Platform (`queue_p95_sustained`)   | Acknowledge ≤5 m, shift enqueueing to interactive-only, add WorkerPal capacity, post updates every 15 m.                     |
| `queue_p95` ≥ 2.0 s **or** queue depth > 60 **or** <2 idle workers for 5 polls | PagerDuty escalation + mirrored Slack incident            | Page WorkerPals Runtime, throttle background work entirely, prep leadership/status comms until p95 drops below 1.0 s.        |

## Recovery / Runbook

1. **Confirm telemetry**: Snapshot `/system/status` (`slo.requests.queueWaitMs`, `queues.*Snapshot`) plus Grafana panels; ensure readings reflect the alert window, not cached data.
2. **Protect interactive users**: Immediately defer or pause background/eval submissions (LocalBuddy + Admin console) whenever pending interactive ≥ 15 so interactive p95 stays anchored at 0 ms.
3. **Add or recover worker capacity**: Launch extra WorkerPals (`bun run workerpals:only[:docker]`) and restart any worker stuck `busy` longer than the queue wait SLO; verify `/workers` reports ≥3 idle slots per lane.
4. **Clear stuck jobs**: Inspect `queues.jobPendingSnapshot` for hot-looping jobs or approvals; fail and recreate the offenders, and unblock manual approvals via `/requests/:id`.
5. **Check upstream deps**: Compare Worker Backends RPC latency and storage/Git health; when upstream slowness is confirmed, redirect lightweight prompts through the deterministic (`requires_worker=false`) lane to free queue capacity.
6. **Communicate and document**: Maintain a `#pushpals-ops` thread with timestamps, mitigations attempted, and pending risks until `queue_p95` returns to 0 ms for 10 consecutive polls; attach the latest `/system/status` snapshot to the PagerDuty incident.
7. **Escalate fast**: If `queue_p95` stays above 1.5 s for 10 m or automated remediation cannot restore idle workers, escalate to Reliability Lead and broaden comms (status page + leadership DM). Keep documentation scoped to queue actions; log any follow-ups in `queue-playbook.md`.
