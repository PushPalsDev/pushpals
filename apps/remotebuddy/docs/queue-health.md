# RemoteBuddy queue health triage

Use this runbook when requests are not being planned, jobs are waiting, or queue latency is increasing. It relies only on controls and telemetry implemented in this repository.

## Establish the failing stage

1. Confirm Server is reachable:

   ```bash
   curl -sS http://127.0.0.1:3001/healthz
   curl -sS http://127.0.0.1:3001/system/status
   ```

2. Classify the backlog from `/system/status`:

   | Observation                                              | Owning stage                                 |
   | -------------------------------------------------------- | -------------------------------------------- |
   | `queues.requests.pending > 0`, no claim activity         | RemoteBuddy planning                         |
   | Requests remain `claimed` without renewal/progress       | RemoteBuddy process or Server connectivity   |
   | `queues.jobs.pending > 0`, no online workers             | WorkerPal capacity/startup                   |
   | Claimed job has no recent job logs                       | WorkerPal execution or lost worker lease     |
   | `queues.jobs.finalizing > 0` or completion backlog grows | SourceControlManager publication             |
   | `queues.repositoryAgentHealth.unhealthy=true`            | RepositoryAgent worker hosted by RemoteBuddy |

3. Inspect the oldest relevant rows rather than relying on queue depth alone:

   ```bash
   curl -sS "http://127.0.0.1:3001/requests?status=pending&limit=20"
   curl -sS "http://127.0.0.1:3001/jobs?status=all&limit=20"
   curl -sS "http://127.0.0.1:3001/workers/autoscale?ttlMs=15000"
   curl -sS "http://127.0.0.1:3001/completions?status=all&limit=20"
   ```

## Request backlog

Healthy RemoteBuddy startup includes these messages:

```text
[RemoteBuddy] Using session: ...
[RemoteBuddy] Starting polling loop (every ...ms)
```

When requests stay pending:

- Confirm the RemoteBuddy process is alive and attached to the same Server URL/database as the client.
- Look for `Poll error`, session-monitor errors, LLM failures, or supervisor restart-limit messages.
- Compare `queues.requestPendingSnapshot` with `slo.requests.queueWaitMs`; the snapshot is current, while the percentile is a 24-hour terminal-history statistic.
- Check whether a request is an unconfirmed autonomous dispatch. Such a row is intentionally hidden from claimers until its reservation is confirmed or expires.

When a request stays claimed, do not manually mark it failed. RemoteBuddy renews its lease every 30 seconds, and Server recovers expired claims during normal request/status operations. A live claim may legitimately be waiting on the planner model.

## Job backlog

Check `GET /workers` and `GET /workers/autoscale`.

- With `auto_spawn_workerpals=true`, RemoteBuddy tries to maintain `min_workerpals` and scales toward `max_workerpals` from busy workers plus autoscalable pending jobs. Open unmerged WorkerPal PRs may impose a small capacity floor.
- Worker online state is derived from heartbeat age. A process can exist but still be offline from Server's perspective.
- If Docker-backed startup is required, inspect Docker itself and the `Spawning WorkerPal`, startup-timeout, and process-exit logs.
- If auto-spawn is disabled, start a worker using the repository's supported command: `bun run workerpals:only` or `bun run workerpals:only:docker`.
- There are no lane-specific worker counts and no `--drain` command. Priorities and work classes are scheduler attributes on one durable job queue.

For one failing job, fetch its persisted logs, tool runs, and terminal diagnostics. Do not immediately enqueue a replacement: stale-claim recovery distinguishes retry-safe work from work that requires manual review, and blindly duplicating a job can produce competing commits.

## Finalization backlog

A `finalizing` job has crossed the WorkerPal-to-SCM handoff. Inspect `queues.publication`, `/completions`, and SourceControlManager logs. Restarting RemoteBuddy will not publish it.

Keep the candidate ref and shared database intact. SourceControlManager and Server use them to reconcile ambiguous callbacks and retained publication candidates.

## Safe restart order

For a source checkout, the preferred recovery is to stop the managed stack cleanly and restart it with:

```bash
bun run start
```

That path performs the repository's supported dependency, configuration, Git, Docker/image, port, and warmup checks.

If services are being managed manually, start Server first, then RemoteBuddy, then any manually managed WorkerPals, and finally SourceControlManager. RemoteBuddy can start before a worker is online and will prewarm/auto-scale workers when configured. Preserve `outputs/data/pushpals.db` and `outputs/data/remotebuddy-state.db` throughout the restart.

## Verification

After recovery, verify behavior rather than an invented global threshold:

- Server health returns `ok: true`.
- RemoteBuddy logs a successful session and polling loop.
- Pending requests are being claimed and their oldest age stops increasing.
- Worker heartbeats are current and claimed jobs gain logs/activity.
- Queue-deadline misses stop accumulating.
- Finalizing jobs advance only when SourceControlManager is online.
- A new low-risk request traverses the expected request or request-to-job path.

If the same stage fails again, preserve its logs and follow the symptom-specific [recovery playbook](./queue-playbook.md).
