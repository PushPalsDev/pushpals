# RemoteBuddy Queue Maintenance (`queue_p95`)

_Last updated: 27 February 2026 — mirrors the canonical guardrail table in `apps/remotebuddy/README.md`._

RemoteBuddy’s live queue normally idles near zero wait, but **all operational guardrails come from
the shared `QUEUE_GUARDRAILS_TABLE`**. Treat the table below as context only and defer to the canonical
limits before taking action. Keep this playbook scoped to queue latency; deeper debugging steps still
live in `apps/remotebuddy/docs/queue-playbook.md`.

## Current Metrics

| Signal | Baseline expectation | Notes |
| --- | --- | --- |
| `queue_p95` (interactive lane) | ≤ 1.0 s (Healthy guardrail) | The queue usually hovers near 0.1 s, but any sustained breach of the Healthy row in the guardrail table is actionable. Use Grafana “RemoteBuddy Queue Overview” side-by-side (last 15 m vs 24 h) to confirm trends. |
| Pending interactive (`pendingInteractive` / `.queues.requestPriorities.interactive`) | < 10 (Healthy guardrail) | Mirrors the Healthy row in the guardrail table. Rising backlog almost always precedes latency before alerts fire, so pause background/eval submissions before it crosses 15. |
| Worker idle slots | ≥ 6 total (≈ 2 per lane via `.workers.idle`) | Matches the Healthy guardrail; maintain this runway so automation (`forceWorker`) can drain spikes. Below this threshold run step 3 in the runbook. |

## Canonical queue + idle guardrails

Mirrors `apps/remotebuddy/README.md`. Update that file first, then sync this block.

<!-- QUEUE_GUARDRAILS_TABLE:start -->
| Band | Conditions (observed via `/system/status`) | Operator action |
| --- | --- | --- |
| **Healthy** | `queue_p95` ≤ 1.0 s, pending interactive < 10, and idle workers ≥ 6 total (≈ 2 per lane via `.workers.idle`). | Keep `/system/status` tailing hourly; capture baseline snapshots once per shift. |
| **Warning** | `queue_p95` 1.0–1.5 s for ≥ 3 polls, or pending interactive ≥ 15 for ≥ 3 polls, or idle workers < 6 total for 3 polls. | Trigger queue-playbook diagnostics, pause background/eval submissions, and confirm queue automation already injected remediation jobs. |
| **Degradation** | `queue_p95` ≥ 1.5 s for ≥ 5 min, or pending interactive ≥ 30, or queue depth > 60 while idle workers stay < 6 total. | Announce in `#pushpals-ops`, throttle enqueueing to interactive-only, add WorkerPal capacity until idle ≥ 6 total again, and watch `jobPendingSnapshot` for stalls. |
| **Incident** | `queue_p95` ≥ 2.0 s, or queue depth > 60 for 5 polls, or idle workers < 6 total for 5 polls. | Page RemoteBuddy Platform + WorkerPals Runtime, freeze background traffic, and post 15 min updates until `queue_p95` < 1.0 s and idle ≥ 6 total for two consecutive polls. |
<!-- QUEUE_GUARDRAILS_TABLE:end -->

## Recovery / Runbook

1. **Confirm telemetry**: Snapshot `/system/status` (`slo.requests.queueWaitMs`, `queues.*Snapshot`) plus Grafana panels; ensure readings reflect the alert window, not cached data.
2. **Protect interactive users**: Immediately defer or pause background/eval submissions (LocalBuddy + Admin console) whenever `pendingInteractive` ≥ 15 so interactive p95 stays inside the Healthy guardrail (≤ 1.0 s).
3. **Add or recover worker capacity**: Launch extra WorkerPals (`bun run workerpals:only[:docker]`) and restart any worker stuck `busy` longer than the queue wait SLO (≤ 1.0 s for Healthy); verify `/workers` reports ≥ 6 idle slots total (≈ 2 per lane).
4. **Clear stuck jobs**: Inspect `queues.jobPendingSnapshot` for hot-looping jobs or approvals; fail and recreate the offenders, and unblock manual approvals via `/requests/:id`.
5. **Check upstream deps**: Compare Worker Backends RPC latency and storage/Git health; when upstream slowness is confirmed, redirect lightweight prompts through the deterministic (`requires_worker=false`) lane to free queue capacity.
6. **Communicate and document**: Maintain a `#pushpals-ops` thread with timestamps, mitigations attempted, and pending risks until `queue_p95` stays within the Healthy guardrail (≤ 1.0 s) for 10 consecutive polls; attach the latest `/system/status` snapshot to the PagerDuty incident.
7. **Escalate fast**: If `queue_p95` stays above 1.5 s for 10 m or automated remediation cannot restore idle workers, escalate to Reliability Lead and broaden comms (status page + leadership DM). Keep documentation scoped to queue actions; log any follow-ups in `queue-playbook.md`.
