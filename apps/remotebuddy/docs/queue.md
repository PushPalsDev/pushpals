# RemoteBuddy Queue Monitoring (`queue_p95`)

_Last updated: 23 February 2026 — reflects the past month of queue_p95 handling._

Use this guide whenever RemoteBuddy request latency (`queue_p95`) drifts away from the ≤1.0 s
SLO, or whenever alerts related to queue depth/backlog fire. The deeper triage commands
and background reading still live in `apps/remotebuddy/docs/queue-playbook.md`.

Need a concrete walkthrough of how a user request flows across LocalBuddy, RemoteBuddy, WorkerPals, and SourceControlManager? See [request-workflow-example.md](./request-workflow-example.md).

## Monitoring and Detection

### Dashboards and tools in rotation

| Surface | What to watch | Access / Notes |
| --- | --- | --- |
| Grafana › RemoteBuddy Queue Overview | `queue_p95`, per-lane backlog, retry spikes (panels: `queue_p95`, `requests_pending`, `jobs_pending`) | Auto-refresh 30 s. Pin compare window (last 4 h vs 24 h) to confirm trend reversals. |
| Grafana › Worker Backends Latency | Worker RPC p95/p99, upstream saturation | Helps prove whether queue inflation started upstream (LLM/storage) before spending time on workers. |
| Server `/system/status` API | `slo.requests.queueWaitMs`, `queues.requestPendingSnapshot`, `queues.jobPendingSnapshot`, worker idle counts | Run `curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status | jq '{queues, slo}'`. Bookmark per-priority depth. |
| Client Ops board (`bun run client:only` → Ops tab) | Real-time session ETA + backlog overlay | Highlights user-facing retries and which sessions are waiting longest. |
| WorkerPals logs (`bun run workerpals:only[:docker]`) | `task.execute` retries, wrapper timeouts | Use alongside `/workers` to ensure idle slots exist; match timestamps with Grafana spikes. |

### Thresholds that matter (current baseline 0.7 s–0.9 s p95)

| Signal | Warning (Slack) | Paging (PagerDuty) | Expectation |
| --- | --- | --- | --- |
| `queue_p95` 15 min rolling | ≥ 1.5 s sustained for 2 minutes → Grafana alert `queue_p95_spike_warning` posts in `#pushpals-ops` and tags `@remote-queue-oc`. | ≥ 2.0 s for 5 minutes → `queue_p95_sustained` pages the **RemoteBuddy Platform** schedule and mirrors the message into `#pushpals-ops`. | Acknowledge in ≤5 minutes, start mitigation, post status thread until resolved. |
| Interactive backlog (`requests.pending.interactive`) | > 40 requests for 3 consecutive polls → Slack reminder in `#pushpals-ops`. | > 60 requests or any request older than 10 minutes → auto-page RemoteBuddy Platform on-call. | Throttle new background/eval traffic within 5 minutes, document deferrals. |
| Worker idle slots | < 2 idle workers per queue lane for 3 polls → Slack ping to `@workerpals-oc`. | ≤ 1 idle worker across cluster for 5 minutes → WorkerPals Runtime schedule secondary page. | Add capacity or shed load before queue wait breaches escalate further. |

### Alert routing

- Grafana alerts land in `#pushpals-ops`. Start a thread per alert, record timestamps,
  and pin remediation steps. If alert is paging, include the PagerDuty incident URL.
- PagerDuty service: **RemoteBuddy Platform** (primary). If unacknowledged for 5 minutes,
  Alertmanager auto-escalates to **WorkerPals Runtime**; a further 10 minutes routes to the
  **Reliability Lead** rotation.
- Manual escalation remains via `/pd trigger` in Slack or by calling the on-call phone tree.

## Required Remediation Steps

1. **Confirm telemetry**: Snapshot `/system/status` and Grafana panels (queue_p95 + backlog).
   Validate that metrics match the alert window (avoid stale data). Note current worker idle counts.
2. **Identify the lane causing pain**: Determine whether interactive, normal, or background queues
   are saturating. If background/eval, immediately pause or defer new submissions via LocalBuddy or
   Admin console to protect interactive SLOs.
3. **Add or recover capacity**: Launch another WorkerPals process (`bun run workerpals:only` or
   `workerpals:only:docker`) and confirm `/workers` shows fresh `idle` slots within 30 s. Restart or
   reap any worker stuck `busy` > queue wait budget.
4. **Clear stuck jobs/requests**: Review `queues.jobPendingSnapshot` for hot-looping jobs, fail +
   recreate them with corrected parameters, and unblock approvals (PATCH or `/requests/:id` admin).
5. **Check dependencies**: Inspect Worker Backends Latency and git/storage health. If upstream
   slowness is confirmed, switch lightweight prompts to deterministic lane (`requires_worker=false`)
   so long-running operations keep worker bandwidth.
6. **Communicate + document**: Update `#pushpals-ops` thread every 15 minutes while p95 ≥ 1.5 s,
   note which mitigations ran, and log outstanding risks. Capture the `/system/status` snapshot in
   the PagerDuty incident.
7. **Escalate quickly**: If queue_p95 stays ≥ 2.0 s or backlog > 60 requests for 10 minutes despite
   actions above, escalate to the Reliability Lead and broaden comms (status page / leadership DM).

## Owners and Escalation Path

| Role | Contact | Responsibility |
| --- | --- | --- |
| Primary owner | Slack `@remote-queue-oc`, PagerDuty **RemoteBuddy Platform** | Owns queue SLO, triage, comms, mitigation coordination. |
| Backup / capacity | Slack `@workerpals-oc`, PagerDuty **WorkerPals Runtime** | Adds or repairs workers, inspects job-level failures. |
| Reliability lead | Slack `@reliability-lead` (duty manager), phone tree step 3 | Decides on broader customer comms, coordinates multi-service incidents. |

Escalate in this order if recovery stalls: Primary on-call → WorkerPals Runtime →
Reliability lead → Eng director (auto-notified once PD incident hits priority P1).

## On-Call Handoff Checklist

Complete these steps before the rotation changes (or midway if relief arrives during an incident):

1. Post a snapshot in `#pushpals-ops` that includes current `queue_p95`, backlog per lane, and worker
   counts (name the Grafana panel + timestamp).
2. Confirm every open PagerDuty incident is either resolved or explicitly reassigned to the incoming
   on-call. Add the latest status summary to the PD incident timeline.
3. Document throttles or pausetoggles (background/eval lanes) and ensure they are either lifted or
   clearly assigned for follow-up.
4. List outstanding remediation items (e.g., “restart workerpals-west-02 when back online” or
   “rebuild docker base image once registry maintenance ends”) and tag owners.
5. Verify WorkerPals logs are clean (no active crash loops) and `/workers` shows ≥2 idle workers per
   queue lane; if not, explain why and who is handling it.
6. Ensure `apps/remotebuddy/docs/queue-playbook.md` notes are still accurate if new fixes were added;
   open a follow-up task if documentation drifted.
7. Transfer auth context: confirm the incoming on-call has the current `PUSHPALS_AUTH_TOKEN` and access
   to Grafana, PagerDuty, and Alertmanager, or broker access before logging off.
8. State the next check-in time (even if the queue is healthy) so everyone knows when to re-evaluate
   metrics after handoff.
