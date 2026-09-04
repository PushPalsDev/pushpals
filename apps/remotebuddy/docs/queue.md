# RemoteBuddy queue model

RemoteBuddy consumes Server's durable request queue and produces jobs in Server's durable job queue. There is no queue inside the RemoteBuddy process and no separate RemoteBuddy queue API.

This document is the canonical Buddy-specific queue reference. The companion documents cover [monitoring](./queue-monitoring.md), [health triage](./queue-health.md), and [recovery](./queue-playbook.md).

## Queue ownership and flow

```text
client or LocalBuddy
        |
        v
Server request queue --claim--> RemoteBuddy planner
        |                              |
        | direct response              | task.execute
        v                              v
 request completed               Server job queue
                                       |
                                       v
                                  WorkerPal
                                       |
                              completion candidate
                                       v
                              SourceControlManager
```

Server owns all queue transitions. RemoteBuddy supplies its fixed `agentId`, claim token, and job identity when it mutates a request. WorkerPal and SourceControlManager use their own fenced authorities for later stages.

## Request queue

Request states are `pending`, `claimed`, `completed`, and `failed`.

- Requests are claimed by priority (`interactive`, `normal`, then `background`) and FIFO within a priority.
- Default queue-wait budgets are 20 seconds, 90 seconds, and 240 seconds respectively. They are planning targets, not built-in alert rules.
- RemoteBuddy requests a three-minute lease and renews it every 30 seconds while planning.
- An expired claim can be recovered by Server. A stale planner cannot complete a reclaimed request because transitions require its claim token.
- A direct response completes the request without a job.
- A worker response records `workerRequired=1` and `handoffJobId` before the planning request completes. The request's `outcomeStatus` then follows that job, so a completed planning stage can still be shown as delegated until WorkerPal/SCM reaches a terminal result.
- Autonomous requests are provisionally enqueued and become claimable only after their dispatch reservation is confirmed.

RemoteBuddy serializes planning claims. Its polling loop does not claim another request while a request lease heartbeat is active.

## Job queue

Job states are `pending`, `claimed`, `finalizing`, `completed`, `failed`, `abandoned`, and `publish_blocked`.

RemoteBuddy emits only schema-v2 `task.execute` jobs. The job contains the canonical user instruction plus structured planning metadata: targets, scope hints, discovery hints, acceptance criteria, validation steps, priority, and execution/finalization budgets.

Job ordering accounts for overdue queue deadlines, elevated recovery/repair work classes, ordinary work class, deadline, target-worker affinity, priority, and creation time. It is therefore more specific than simple priority FIFO.

A WorkerPal that has produced a candidate normally enqueues a completion and moves the job to `finalizing`. SourceControlManager's acknowledged completion callback is what moves the job to `completed`. A WorkerPal result alone is not publication success.

## Supported read surfaces

All endpoints belong to Server, normally at `http://127.0.0.1:3001`.

| Endpoint                              | Purpose                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /system/status`                  | Combined queue counts, pending snapshots, SLO summaries, workers, publication backlog, autonomy, repository, and client state. |
| `GET /requests?status=all&limit=N`    | Request rows, counts, priority counts, next-pending snapshot, and 24-hour request SLO summary.                                 |
| `GET /requests/:id`                   | One request, including its durable handoff and projected outcome fields.                                                       |
| `GET /jobs?status=all&limit=N`        | Job rows, counts, priority counts, pending snapshot, and 24-hour job SLO summary.                                              |
| `GET /jobs/:id/logs?limit=N`          | Persisted bounded job log page.                                                                                                |
| `GET /jobs/:id/tool-runs?limit=N`     | Structured tool-run records for a job.                                                                                         |
| `GET /jobs/:id/diagnostics`           | Terminal diagnostic record when one exists.                                                                                    |
| `GET /workers?ttlMs=N`                | Registered WorkerPals with derived `isOnline` and `activeJobCount` values.                                                     |
| `GET /workers/autoscale?ttlMs=N`      | Compact worker, job, completion, publication, and open-PR snapshot used by RemoteBuddy's autoscaler.                           |
| `GET /completions?status=all&limit=N` | SourceControlManager completion queue state.                                                                                   |

The list filters are limited to the states accepted by each route. These are read and diagnostic surfaces; the repository does not provide an operator PATCH route for manually rewriting request or job state.

## Write surfaces used by RemoteBuddy

RemoteBuddy uses these Server routes internally:

- `POST /requests/claim`
- `POST /requests/:id/lease/renew`
- `POST /requests/:id/worker-handoff`
- `POST /requests/:id/complete`
- `POST /requests/:id/fail`
- `POST /jobs/enqueue`
- `POST /sessions/:id/command`

These are protocol transitions rather than operator controls. Do not replay them manually unless you can supply the current fencing authority and understand the idempotency contract.

## Retries and reconciliation

- Job enqueue and request handoff/completion callbacks use at most three attempts by default, with a 10-second hard deadline per attempt.
- Job enqueue retries reuse the same serialized payload and dedupe key. Retryable HTTP responses are 408, 429, and 5xx; a rejected 4xx response is not blindly retried.
- If enqueue may have committed but no acknowledgement arrived, RemoteBuddy leaves the request recoverable. It does not report a false terminal failure.
- If a durable job exists but the request callback is interrupted, Server reconciles the request-to-job handoff.
- Planner errors before a durable job exists fail the claimed request. There is no automatic "sanitized re-plan" loop.

Server also recovers expired claims and reconciles lifecycle state during normal queue/status activity. Preserve the SQLite files across restarts so this recovery evidence remains available.

## What is not implemented

The repository does not define a `queue_p95` metric name, a `/status` queue endpoint, webhook replay, a LocalBuddy admin throttle, per-priority WorkerPal pools, or queue-specific Grafana/Alertmanager/PagerDuty/Slack integration. The built-in percentile is `slo.requests.queueWaitMs.p95` or `slo.jobs.queueWaitMs.p95` in `/system/status`; external deployments may choose to export or alert on it.
