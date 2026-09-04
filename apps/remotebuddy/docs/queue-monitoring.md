# Monitoring RemoteBuddy queues

PushPals exposes queue health through Server's JSON APIs and the client System, Requests, and Jobs views. The repository does not ship a metrics exporter, dashboards, alert rules, paging integration, or chat-ops automation.

Use `GET /system/status` as the primary snapshot. The examples assume the default Server URL:

```bash
curl -sS http://127.0.0.1:3001/system/status
```

On PowerShell, use `curl.exe` if `curl` resolves to `Invoke-WebRequest`.

## Built-in status fields

| JSON path                                        | Meaning                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `runtime.uptimeMs`                               | Age of the current Server process. A recent value helps distinguish a cleared in-memory view from a persistent queue problem. |
| `runtime.reconciliation`                         | Results of guarded lifecycle reconciliation work. Inspect errors before changing queue state.                                 |
| `workers.online`, `workers.busy`, `workers.idle` | WorkerPal capacity using the route's online TTL, 15 seconds by default.                                                       |
| `queues.requests`                                | Request counts by lifecycle status.                                                                                           |
| `queues.requestPriorities`                       | Active request counts in `interactive`, `normal`, and `background`.                                                           |
| `queues.requestPendingSnapshot`                  | Up to ten claimable requests in claim order, with `id`, `priority`, `position`, and estimated `etaMs`.                        |
| `queues.jobs`                                    | Job counts, including `pending`, `claimed`, `finalizing`, and terminal states.                                                |
| `queues.jobPriorities`                           | Active job counts by priority.                                                                                                |
| `queues.jobPendingSnapshot`                      | Up to ten claimable jobs in scheduler order, including `workClass`, `queueDeadlineAt`, and `deadlineMissed`.                  |
| `queues.completions`                             | SourceControlManager completion counts.                                                                                       |
| `queues.publication`                             | Finalization/publication backlog and age information.                                                                         |
| `queues.repositoryAgentHealth`                   | RepositoryAgent counts, stale claims, delayed retries, deadline failures, and its computed `unhealthy` flag.                  |
| `queues.workerPrBacklog`                         | Open, merged, and closed-unmerged PR projection from persisted jobs/provider feedback.                                        |
| `slo.requests`                                   | 24-hour terminal count, success rate, duration, and queue-wait summaries for projected request outcomes.                      |
| `slo.jobs`                                       | 24-hour terminal/no-change/failure counts, deadline misses, and duration/queue-wait summaries.                                |
| `autonomy`                                       | Autonomy safety, activity, failure, queue, and dispatch signals.                                                              |
| `repo`                                           | Cached repository identity/status summary.                                                                                    |

Percentile objects use `{ p50, p95, avg, sampleSize }` in milliseconds. When there are no samples, values are `null`; do not interpret `null` as zero latency.

## Focused reads

Use the narrow endpoints when the combined snapshot shows a problem:

```bash
curl -sS "http://127.0.0.1:3001/requests?status=pending&limit=50"
curl -sS "http://127.0.0.1:3001/jobs?status=all&limit=50"
curl -sS "http://127.0.0.1:3001/workers?ttlMs=15000"
curl -sS "http://127.0.0.1:3001/workers/autoscale?ttlMs=15000"
curl -sS "http://127.0.0.1:3001/completions?status=all&limit=50"
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/logs?limit=200"
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/tool-runs?limit=100"
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/diagnostics"
```

`GET /requests/:id` is available for exact request state. There is no corresponding `GET /jobs/:id`; select the job from `GET /jobs` and use its narrow log/tool/diagnostic routes.

## Health interpretation

Do not alert on a fixed universal latency threshold. Compare observations with each row's configured budget and with recent load:

- Request queue defaults: 20 seconds interactive, 90 seconds normal, 240 seconds background.
- `requestPendingSnapshot[].etaMs` is a scheduling estimate derived from priority and position, not a measured completion ETA.
- `jobPendingSnapshot[].deadlineMissed=true` is stronger evidence than queue depth alone.
- Rising `pending` with no active RemoteBuddy claim suggests the planner is absent or cannot reach Server.
- Rising jobs with zero online workers suggests WorkerPal startup/capacity failure.
- `finalizing` jobs with pending or claimed completions belong to the SourceControlManager stage, not RemoteBuddy.
- A high `slo.*.queueWaitMs.p95` is historical over the last 24 hours of terminal rows. It does not prove the current head of queue is stuck.
- `workers.idle=0` is not automatically unhealthy if workers are busy and work is progressing. Correlate it with log timestamps and queue deadlines.

The autonomy alert thresholds in `[remotebuddy.autonomy]` feed autonomy's own evidence and gating. They do not configure an external alerting system.

## Event and log signals

RemoteBuddy publishes status, assistant, task, and job-related events to the configured Server session. Clients can consume the session's SSE or WebSocket stream with a cursor. Service stdout/stderr remains the authoritative source for planner and worker-spawn failures.

Useful RemoteBuddy log prefixes include:

```text
[RemoteBuddy] Planning request ...
[RemoteBuddy] Planner output: ...
[RemoteBuddy] Worker autoscaler (...)
[RemoteBuddy] Spawning WorkerPal ...
[RemoteBuddy] Job enqueue outcome is ambiguous ...
[RemoteBuddy] Poll error: ...
[RemoteBuddySupervisor] RemoteBuddy exited ...
[RepositoryAgent] ...
```

HTTP polling routes are intentionally omitted from normal Server logs unless debug HTTP logging is enabled. Their absence from ordinary Server output is not evidence that polling stopped.

## External monitoring

An installation may export these JSON fields into its own monitoring stack. If it does, document the exporter, dashboard names, alert thresholds, and escalation ownership in deployment-specific operations documentation. Do not place those assumptions in this repository unless the integration and its configuration are checked in.
