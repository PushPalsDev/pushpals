# RemoteBuddy Queue Operations

_Last updated: 25 February 2026 — sourced from current queue guardrails and monitoring runbooks._

Use this reference whenever RemoteBuddy’s request queues drift from the ≤1.0 s SLO so everyone responds with the same thresholds, alerts, and escalation posture. Pair it with [queue-monitoring](./queue-monitoring.md) for live dashboards and [queue-playbook](./queue-playbook.md) for deep remediation steps.

## Canonical queue + idle guardrails

Synced verbatim with `apps/remotebuddy/README.md`. Update that file first before mirroring changes here.

<!-- QUEUE_GUARDRAILS_TABLE:start -->
| Band | Conditions (observed via `/system/status`) | Operator action |
| --- | --- | --- |
| **Healthy** | `queue_p95` ≤ 1.0 s, pending interactive < 10, and idle workers ≥ 6 total (≈ 2 per lane via `.workers.idle`). | Keep `/system/status` tailing hourly; capture baseline snapshots once per shift. |
| **Warning** | `queue_p95` 1.0–1.5 s for ≥ 3 polls, or pending interactive ≥ 15 for ≥ 3 polls, or idle workers < 6 total for 3 polls. | Trigger queue-playbook diagnostics, pause background/eval submissions, and confirm queue automation already injected remediation jobs. |
| **Degradation** | `queue_p95` ≥ 1.5 s for ≥ 5 min, or pending interactive ≥ 30, or queue depth > 60 while idle workers stay < 6 total. | Announce in `#pushpals-ops`, throttle enqueueing to interactive-only, add WorkerPal capacity until idle ≥ 6 total again, and watch `jobPendingSnapshot` for stalls. |
| **Incident** | `queue_p95` ≥ 2.0 s, or queue depth > 60 for 5 polls, or idle workers < 6 total for 5 polls. | Page RemoteBuddy Platform + WorkerPals Runtime, freeze background traffic, and post 15 min updates until `queue_p95` < 1.0 s and idle ≥ 6 total for two consecutive polls. |
<!-- QUEUE_GUARDRAILS_TABLE:end -->

## Metric checkpoints

| Signal | Healthy | Monitor band | Alert band | Prompt |
| --- | --- | --- | --- | --- |
| `queue_p95` (interactive lane, 15 min rollup) | ≤ 1.0 s | Guardrail **Warning** band: 1.0–1.5 s for ≥ 3 polls (~6 min) or `pendingInteractive` ≥ 15 / idle workers < 6 total for 3 polls. | Guardrail **Degradation/Incident** bands: `queue_p95` ≥ 1.5 s for ≥ 5 min, `pendingInteractive` ≥ 30, queue depth > 60 while idle workers stay < 6 total, or idle workers < 6 total for 5 polls. | Validate backlog shape, idle workers, and worker recycle history. |
| Pending interactive requests | < 10 total | ≥ 15 for ≥ 3 polls (guardrail **Warning** trigger). | ≥ 30 for ≥ 5 min or queue depth > 60 for 5 polls while idle < 6 total (guardrail **Degradation/Incident**). | Pause background/eval submissions, prioritize interactive. |
| `job_failure_rate` | ≤ 0.2 | 0.25–0.4 | ≥ 0.4 | Combine with queue metrics to determine severity; this doc focuses on the queue-only case. |

## Elevated `queue_p95` with zero failures

Seeing `queue_p95` spike to 1.157 s (example: `queue_p95=1157 ms job_failure_rate=0.000`) usually means the workers are saturated or mis-prioritized—not that they are erroring out. The absence of `job_failure_rate` increases or explicit failures simply removes one symptom; it does **not** make the latency acceptable. Treat the queue like a capacity incident whenever the monitor or alert bands are met.

### Monitor vs. alert thresholds

- **Monitor (warning):** `queue_p95` between 1.0 s and 1.5 s for ≥ 3 consecutive `/system/status` polls (~6 min) while `pendingInteractive` stays < 30 and idle workers ≥ 6 total (≈ 2 per lane via `.workers.idle`). Action: open a `#pushpals-ops` thread, capture Grafana RemoteBuddy Queue Overview snapshots, and begin queue-playbook diagnostics while keeping PagerDuty quiet.
- **Alert (paging):** `queue_p95` ≥ 1.5 s for ≥ 5 min, queue depth > 60, or idle workers < 6 total for 5 polls even if failures remain 0. Action: acknowledge/trigger `queue_p95_sustained`, treat as an incident, and throttle input to interactive-only until the backlog contracts.

### Operator runbook and escalation ladder

1. **Snapshot telemetry:** Immediately capture `/system/status` output plus Grafana panels (`queue_p95`, pending queues, worker idle). Post both and the raw metric snippet (e.g., `queue_p95=1157 ms job_failure_rate=0.000`) in `#pushpals-ops`.
2. **Verify automation:** Confirm `sig_queue_health` logs fired and that `forceWorker` remediation jobs are queued. If not present, manually enqueue `forceWorker` with lane `worker` and `origin=manual` and note the timestamp in the ops thread.
3. **Rebalance load:** Pause new background/eval submissions (LocalBuddy admin throttle → `interactive-only`) and drain any evaluators older than 2 min so interactive traffic owns the runway.
4. **Add capacity:** If idle workers < 6 total for 3 polls, recycle stuck workers and add at least one WorkerPal per busy lane. Document each action in the ops thread.
5. **Escalate:**
   - At T+5 min in the alert band, page **RemoteBuddy Platform** (`@remote-queue-oc` via PagerDuty) if not already engaged.
   - If queue_p95 stays ≥ 1.5 s for 10 min, loop in **WorkerPals Runtime** on-call.
   - If ≥ 15 min or backlog > 60 with no recovery path, escalate to the **Reliability Lead** and prep leadership/status comms.
6. **Communicate until green:** Post updates every 15 min and close the thread only after `queue_p95` < 1.0 s and `pendingInteractive` < 10 for two consecutive polls.

Following this flow keeps zero-failure latency spikes visible, ensures the right alerting level, and documents clear ownership for each escalation hop.
