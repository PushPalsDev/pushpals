# RemoteBuddy queue recovery playbook

Use this playbook after [queue-health.md](./queue-health.md) identifies the stalled stage. It intentionally avoids fabricated dashboards, alert channels, deployment tooling, or administrative APIs.

## Preserve evidence first

Before restarting anything, capture:

```bash
curl -sS http://127.0.0.1:3001/system/status
curl -sS "http://127.0.0.1:3001/requests?status=all&limit=100"
curl -sS "http://127.0.0.1:3001/jobs?status=all&limit=100"
curl -sS "http://127.0.0.1:3001/completions?status=all&limit=100"
curl -sS "http://127.0.0.1:3001/workers?ttlMs=15000"
```

For an affected job, also capture:

```bash
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/logs?limit=500"
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/tool-runs?limit=100"
curl -sS "http://127.0.0.1:3001/jobs/JOB_ID/diagnostics"
```

Save the relevant service stdout/stderr. Do not delete the database, worktree, candidate ref, or runtime logs while diagnosing an ambiguous handoff.

## Server unavailable

Symptoms:

- `/healthz` fails.
- RemoteBuddy logs `Server unavailable (...)` during startup or repeated `Poll error` messages.
- Workers and SourceControlManager also lose their control-plane calls.

Actions:

1. Check whether another process owns the configured Server port.
2. Confirm all processes resolve the same loopback Server URL and project root.
3. Prefer restarting the complete stack with `bun run start`; its preflight handles port ownership and repository affinity.
4. If manually managed, start Server before RemoteBuddy. RemoteBuddy retries session bootstrap indefinitely, so it can remain running while Server comes back.
5. Verify `/system/status` and its `runtime.reconciliation` values after Server returns.

SQLite-backed state survives a normal Server restart.

## Requests remain pending

Symptoms:

- `queues.requests.pending` grows.
- `requestPendingSnapshot` ages while RemoteBuddy emits no `Claimed request` log.

Actions:

1. Confirm RemoteBuddy reached `Using session` and `Starting polling loop`.
2. Check supervisor output for repeated exits or `restart limit reached`.
3. Check model/backend setup if claims are followed by `RemoteBuddy planning failed`.
4. Inspect `GET /requests/:id` for priority, claim state, confirmation fields, and prior errors.
5. If RemoteBuddy is wedged, stop and restart only that service with `bun run remotebuddy:only`. Leave Server and both databases intact.

RemoteBuddy requests a three-minute lease and renews every 30 seconds. Server will recover an expired claim. There is no supported manual "release request" route.

## Planning is slow or fails

Symptoms:

- Request remains claimed with fresh heartbeat timestamps.
- Planner/backend errors appear before a job ID exists.
- RemoteBuddy emits a planning-failure assistant message and the request becomes failed.

Actions:

1. Validate the configured `[remotebuddy.llm]` backend using the normal `bun run start` preflight.
2. Check network/local model availability and the configured model/auth mode.
3. Inspect repo-hint preflight warnings and whether the request names stale/nonexistent target paths.
4. Narrow the request if planning or worker guidance is too broad.
5. Submit a new request only after the previous request is durably failed. RemoteBuddy does not perform the previously documented automatic sanitized re-plan.

Do not infer a failure solely because `queueWaitMs.p95` increased; that metric measures time before claim, not model planning time.

## Job enqueue acknowledgement is ambiguous

Symptoms:

- `Job enqueue outcome is ambiguous after 3 attempt(s)`.
- User receives a message that automatic reconciliation is being preserved.
- Request may remain claimed temporarily even though a matching job exists.

Actions:

1. Search `GET /jobs` for the request's job and dedupe identity.
2. Inspect `GET /requests/:id` for `workerRequired` and `handoffJobId`.
3. Allow Server's handoff reconciliation to close the crash window.
4. Restart RemoteBuddy only if needed; retain its planning-memory/compatibility database.
5. Do not enqueue a duplicate or force an opposite terminal transition.

RemoteBuddy retries only retryable/ambiguous responses (408, 429, 5xx, and transport failures), reusing the byte-identical payload. A definitive client error is not blindly retried. This protection uses Server's durable dedupe contract; the legacy `IdempotencyStore` methods are not used by the current polling path.

## Jobs remain pending

Symptoms:

- `queues.jobs.pending` grows.
- `workers.online` is zero, all workers are busy, or `jobPendingSnapshot[].deadlineMissed` becomes true.

Actions:

1. Read `GET /workers/autoscale` to distinguish total pending jobs from `autoscalablePending` jobs.
2. Check RemoteBuddy's configured `auto_spawn_workerpals`, `min_workerpals`, `max_workerpals`, Docker requirement, image, and startup timeout.
3. Inspect logs for worker spawn cooldown or startup timeout.
4. Verify Docker only when the effective worker configuration uses or requires it.
5. Add a manual worker with `bun run workerpals:only` or `bun run workerpals:only:docker` if auto-spawn is intentionally disabled or capped.
6. Confirm the new worker appears online and begins logging against the job.

Do not assume every pending job can be autoscaled: delayed jobs and jobs targeted to a still-online worker are excluded from the autoscalable count.

## Claimed job stops making progress

Symptoms:

- Job is claimed but has no recent activity/log timestamp.
- Worker heartbeat disappears or no longer names the job.

Actions:

1. Inspect the job's logs, tool runs, and terminal diagnostics.
2. Inspect the worker row's heartbeat, active job count, status, and current job.
3. Check the WorkerPal process/container and its hard execution deadline.
4. Let Server's stale-claim recovery classify the work. Retry-safe work may be requeued; potentially side-effectful work can require manual review or become abandoned.
5. Do not start a parallel replacement against the same candidate without that classification.

RemoteBuddy observes terminal `job_failed` events and can fetch a bounded failure-log summary, but it does not automatically issue the old documented one-shot `fix_up` job. Review repair is a separate, capability-controlled SCM workflow.

## Jobs remain finalizing

Symptoms:

- `queues.jobs.finalizing` grows.
- `queues.publication` or `/completions` shows pending/claimed work.
- Worker execution has already produced a candidate ref/SHA.

Actions:

1. Move diagnosis to SourceControlManager logs and completion state.
2. Preserve the candidate ref, source SHA, and completion record.
3. Check integration worktree, remote access, trusted validation, and publication state.
4. Restart SourceControlManager—not RemoteBuddy—if its process is absent.
5. Let completion lease recovery and callback reconciliation handle an interrupted publisher.

There is no webhook to replay. Publication completion is a fenced Server callback from SourceControlManager.

## RepositoryAgent unhealthy

Symptoms:

- `queues.repositoryAgentHealth.unhealthy` is true.
- Counts show old pending/claimed work, delayed retries, exhausted attempts, or past-deadline active work.
- `[RepositoryAgent]` logs show repeated model or snapshot failures.

Actions:

1. Confirm RemoteBuddy started the shared repository capability.
2. Inspect the health structure rather than the request queue; RepositoryAgent has its own queue and lease contract.
3. Verify the RemoteBuddy LLM configuration and repository identity/snapshot evidence.
4. Restart RemoteBuddy if the hosted worker is absent. Caller timeouts do not cancel already durable RepositoryAgent work.

## Autonomy is idle

Autonomy deliberately stops dispatching for many healthy reasons. Inspect:

```bash
curl -sS http://127.0.0.1:3001/autonomy/safety
curl -sS http://127.0.0.1:3001/autonomy/insights
```

Then check the configured enable flag and kill switch, startup grace, dirty-worktree policy, dispatch lock, worker capacity, request/publication backpressure, hourly dispatch/resource budgets, cooldown/freeze state, unanswered questions, and evaluator gates.

Changing `remotebuddy.autonomy.enabled` through the supported runtime-config surface is applied live. Other autonomy settings should be treated as restart-required unless their implementation explicitly states otherwise.

## Recovery validation

After any intervention:

1. Re-capture `/system/status` and compare the same queue stage.
2. Verify claim/activity timestamps advance.
3. Verify no new deadline misses or terminal failures appear for the same cause.
4. Submit one bounded low-risk request and follow its exact request/job IDs.
5. Keep any external incident record in the deployment's operations system. This repository intentionally does not assume a paging service, Slack channel, team alias, or response-time target.

## Configuration levers

The supported queue/capacity levers are in [`configs/default.toml`](../../../configs/default.toml):

- `remotebuddy.poll_ms`
- `remotebuddy.workerpal_online_ttl_ms`
- `remotebuddy.wait_for_workerpal_ms`
- `remotebuddy.auto_spawn_workerpals`
- `remotebuddy.min_workerpals` / `max_workerpals`
- `remotebuddy.workerpal_startup_timeout_ms`
- `remotebuddy.workerpal_docker` / `workerpal_require_docker` / `workerpal_image`
- RemoteBuddy execution/finalization budgets
- `[remotebuddy.autonomy]` dispatch, backpressure, cooldown, and safety settings

Change one bounded variable at a time, restart when required, and verify it through the built-in status fields. The previously documented `REMOTE_QUEUE_*`, `WORKER_LANE_*`, `REMOTE_TUNE_*`, and `REMOTE_AUTOPAUSE_*` variables are not implemented configuration keys.
