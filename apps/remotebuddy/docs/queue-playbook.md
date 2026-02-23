# Queue Triage Playbook

This playbook covers the request/job queue degradation that surfaced when `queue_p95`
climbed above its service target. Follow it whenever queue wait complaints or worker
timeouts point back to RemoteBuddy + WorkerPals orchestration.

## When To Use

- Server `/system/status` shows `slo.requests.queueWaitMs.p95` ≥ 1.5 s.
- Users report sluggish status updates while the dashboard highlights retry spikes.
- WorkerPals logs surface repeated `task.execute` failures or wrapper timeouts.

## Expected Metrics & Tooling

| Metric | Target / SLO | Current observation | Tooling |
| --- | --- | --- | --- |
| `queue_p95` (request wait) | ≤ 1.0 s | 1.9 s observed since 2026-02-23 | `curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status \| jq '.slo.requests.queueWaitMs'` |
| Pending request depth | < 30 interactive, < 10 background | Rising backlog (check per-priority) | Server queue snapshots: `http://localhost:3001/requests?status=pending` |
| Pending job depth | < 20 runnable jobs | Saturated job queue w/ identical intents | `http://localhost:3001/jobs?status=pending` |
| Retry/failure rate | < 5 % retries, < 2 % hard fails | Retry spikes tied to `task.execute` | Grafana › RemoteBuddy Queue Overview, or `apps/client` status board |
| Worker online count | ≥ 2 active WorkerPals per queue lane | Drops to zero/one during incident | `http://localhost:3001/workers`, WorkerPals daemon logs |

> Tip: every endpoint above requires `PUSHPALS_AUTH_TOKEN`. Export it in your shell
> or pass `-H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN"` explicitly.

## Symptoms To Confirm

- RemoteBuddy emits `job_failed` events where `detail` contains `task.execute` and the same
  job ID is retried multiple times within 5 minutes.
- WorkerPals terminal shows `wrapper timed out`, `queue wait budget exhausted`, or backend
  connection churn that lines up with the queue_p95 surge.
- Server `/requests` payloads show dozens of `pending` entries with stale `createdAt` values.
- Clients (LocalBuddy or UI) report `retrying after 5s` banner more frequently than baseline.

## Diagnostic Steps

### 1. Queue Depth & Priorities

1. Pull a snapshot:
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
     "http://localhost:3001/system/status" | jq '{queues, slo.requests.queueWaitMs}'
   ```
2. Confirm whether interactive or background lanes are overloaded. If one priority dominates,
   consider throttling new submissions from that lane.
3. Inspect individual pending requests to ensure none are stuck awaiting approvals:
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
     "http://localhost:3001/requests?status=pending&limit=20" \
     | jq '.pendingSnapshot'
   ```

### 2. Worker Health & Capacity

1. List online workers and last heartbeat:
   ```bash
   curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
     "http://localhost:3001/workers" | jq '.workers[] | {workerId, status, lastHeartbeat}'
   ```
2. Tail WorkerPals logs (started via `bun run workerpals:only`) for `task.execute` failures,
   backend crash loops, or docker warmup churn.
3. If workers show as `busy` for > queue wait budget while not emitting logs, recover the job
   via Server stale-claim sweep (`system/status` already kicks this every fetch) or restart
   the offending worker.

### 3. Dependency Latency

1. LLM/backends: watch Grafana › Worker Backends Latency (or `apps/workerpals` log timings) for
   spikes above 20 s per call. Elevated upstream latency cascades into queue wait inflation.
2. SourceControlManager / git: verify `/system/status.repo` payload reports `ok: true`; failing
   git remotes force retries on `task.execute`.
3. Autonomy store: RemoteBuddy logs referencing `Database busy` indicate SQLite contention—ensure
   no long-running migrations or disk pressure.

## Mitigation Actions

- **Prioritize critical load**: temporarily pause background or eval sessions by toggling their
  `priority` to `deferred` via `PATCH /requests/:id` (or cancel/re-enqueue when patching is not
  available).
- **Add worker capacity**: launch an extra WorkerPals process (`bun run workerpals`) pointing at
  the same Server; confirm `/workers` reflects additional `idle` slots within 30 s.
- **Retry stuck batches**: identify jobs looping on retry (`system/status.queues.jobPendingSnapshot`)
  and manually fail+requeue them with corrected `task.execute` params.
- **Protect the platform**: if dependency latency is external (LLM/vendor outage), switch RemoteBuddy
  planner to deterministic lane (set `requires_worker=false`) for lightweight prompts so that only
  essential `task.execute` traffic remains.
- **Communicate status**: post incident updates in `#pushpals-ops` every 15 minutes while queue_p95
  stays > target.

## Escalation Criteria

Escalate to the platform on-call or reliability lead when any condition below lasts > 10 minutes:

- `queue_p95` ≥ 2.0 s or queue depth > 60 requests with no downward trend.
- Worker online count ≤ 1 for the entire cluster or `workers.idle` = 0 for 5 consecutive polls.
- `task.execute` hard failure rate exceeds 10 % (count `job_failed` events / total jobs).
- Dependency latency rooted in external providers (LLM, git, Docker image registry) shows no recovery.

When escalating, include:

- Latest `/system/status` JSON (redacted token).
- Recent WorkerPals log snippet showing `task.execute` errors.
- Actions already attempted from the mitigation list and their outcomes.
