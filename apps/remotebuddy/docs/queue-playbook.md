# RemoteBuddy Queue Tuning & Rollback Playbook

_Last updated: 24 February 2026 — 23–24 Feb low-load window (`queue_p95` 0.533 s ± 0.075 s; job failures 0)._ 

Use this playbook when RemoteBuddy queue wait is drifting from the low-load contract but the paging
bands documented in `apps/remotebuddy/docs/queue.md` have not triggered. The monitoring doc handles
high-severity incidents; this playbook documents how to stay inside the low-load envelope, which
sources back each lever, and the exact rollback plus follow-up actions so the low-load reference
remains single-sourced.

## Baseline + Thresholds (23–24 Feb 2026 low-load window)

The table below is the only authoritative baseline and threshold reference. It combines the
22:00 UTC 23 Feb → 02:00 UTC 24 Feb Grafana snapshots, Alertmanager rules, and PromQL queries. Do
not maintain duplicate bullet lists elsewhere—update this table when baselines shift.

| Signal | Baseline (23–24 Feb) | Warning threshold + sources | Rollback trigger + sources |
| --- | --- | --- | --- |
| `queue_p95` (interactive, 15 min rollup) | 0.533 s ± 0.075 s with ≤ 35 interactive RPS and ≤ 10 eval/background RPS. | ≥ 0.8 s for ≥ 5 min without matching traffic.<br>• Grafana panel — [RemoteBuddy Queue Overview › `queue_p95`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=queue_p95)<br>• Alert rule — [`queue_p95_spike_warning`](alertmanager://remote-buddy-platform/rules/queue_p95_spike_warning)<br>• PromQL — [`histogram_quantile(0.95,sum(rate(remote_queue_wait_ms_bucket{lane="interactive"}[15m])))`](promql://remote_queue_wait_ms_bucket/p95-interactive)<br>• Evidence (2026‑02‑24 00:45 UTC) — [Grafana snapshot](grafana://snapshots/remotebuddy-queue/low-load-20260224T0045Z) | ≥ 0.9 s for ≥ 5 min or ± > 75 ms jitter immediately after a lever change.<br>• Grafana panel — [RemoteBuddy Queue Overview › `queue_p95`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=queue_p95)<br>• Alert rule — [`queue_p95_sustained`](alertmanager://remote-buddy-platform/rules/queue_p95_sustained)<br>• PromQL — [`stddev_over_time(remote_queue_wait_ms_bucket{lane="interactive"}[15m])`](promql://remote_queue_wait_ms_bucket/stddev)<br>• Evidence (2026‑02‑24 00:45 UTC) — [Grafana snapshot](grafana://snapshots/remotebuddy-queue/low-load-20260224T0045Z) |
| Pending interactive requests (`requests.pending.interactive`) | < 10 per lane steady state. | > 15 for 3 polls (~6 min) while traffic remains ≤ 35 RPS.<br>• Grafana panel — [`requests_pending`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=requests_pending)<br>• Alert rule — [`queue_pending_interactive_warning`](alertmanager://remote-buddy-platform/rules/queue_pending_interactive_warning)<br>• PromQL — [`sum(queues_requests_pending{priority="interactive"})`](promql://queues_requests_pending/interactive)<br>• Evidence (2026‑02‑24 00:55 UTC) — [Slack ops log](slack://channel/queue_p95_spike_warning/p/202602240055) | ≥ 20 or any interactive wait > 2 min; revert the last lever immediately.<br>• Grafana panel — [`requests_pending`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=requests_pending)<br>• Alert rule — [`queue_pending_interactive_page`](alertmanager://remote-buddy-platform/rules/queue_pending_interactive_page)<br>• PromQL — [`sum(queues_requests_pending{priority="interactive"})`](promql://queues_requests_pending/interactive)<br>• Evidence (2026‑02‑24 00:55 UTC) — [Slack ops log](slack://channel/queue_p95_spike_warning/p/202602240055) |
| Worker idle slots (per lane) | ≥ 3 idle workers per lane; no worker stuck `busy` beyond queue budget. | < 3 idle workers for 3 consecutive `/system/status` polls.<br>• API — [/system/status `queues.requestPendingSnapshot` + `workers`](runbook://server/system-status#queues)<br>• Grafana panel — [Worker Backends Latency › `idle_slots`](grafana://d/worker-backends/latency?viewPanel=idle_slots)<br>• Alert rule — [`worker_idle_lane_warning`](alertmanager://workerpals-runtime/rules/worker_idle_lane_warning)<br>• PromQL — [`sum(remote_worker_idle_slots{lane=~"interactive\|background"})`](promql://remote_worker_idle_slots/sum)<br>• Evidence (2026‑02‑24 01:00 UTC) — [PagerDuty incident PD-REMOTE-2026-02-24-01](pagerduty://incidents/PD-REMOTE-2026-02-24-01) | ≤ 1 idle worker cluster-wide for ≥ 5 min or automation fails to recover idle slots.<br>• Grafana panel — [Worker Backends Latency › `idle_slots`](grafana://d/worker-backends/latency?viewPanel=idle_slots)<br>• Alert rule — [`worker_idle_global_page`](alertmanager://workerpals-runtime/rules/worker_idle_global_page)<br>• PromQL — [`sum(remote_worker_idle_slots{lane=~"interactive\|background"})`](promql://remote_worker_idle_slots/sum)<br>• Evidence (2026‑02‑24 01:00 UTC) — [PagerDuty incident PD-REMOTE-2026-02-24-01](pagerduty://incidents/PD-REMOTE-2026-02-24-01) |
| Job failures (`queues.jobPendingSnapshot.failed`) | 0 failures, 0 worker retry bursts. | Any increment > 0 or retries > 3/min tied to tuning.<br>• Grafana panel — [`jobs_pending`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=jobs_pending)<br>• Alert rule — [`queue_job_failure_warning`](alertmanager://remote-buddy-platform/rules/queue_job_failure_warning)<br>• PromQL — [`sum(rate(remote_jobs_failed_total[5m]))`](promql://remote_jobs_failed_total/rate)<br>• Evidence (2026‑02‑24 01:05 UTC) — [WorkerPals log bundle](s3://pushpals-ops/queue-low-load/workerpals-20260224T0105Z.log) | Failure rate ≥ 0.5/min or alert reopens twice within 30 min for the same knob.<br>• Grafana panel — [`jobs_pending`](grafana://d/remotebuddy-queue/queue-overview?viewPanel=jobs_pending)<br>• Alert rule — [`queue_job_failure_page`](alertmanager://remote-buddy-platform/rules/queue_job_failure_page)<br>• PromQL — [`sum(rate(remote_jobs_failed_total[5m]))`](promql://remote_jobs_failed_total/rate)<br>• Evidence (2026‑02‑24 01:05 UTC) — [WorkerPals log bundle](s3://pushpals-ops/queue-low-load/workerpals-20260224T0105Z.log) |
| Synthetic probe latency (`probe.queue_lowload`) | < 550 ms round-trip, 0 drops per 20 samples. | ≥ 650 ms for 2 probes or 1 drop/20 samples.<br>• Grafana panel — [Synthetic Queue Probes › `queue_lowload`](grafana://d/remotebuddy-synth/probe?viewPanel=queue_lowload)<br>• Alert rule — [`probe_queue_lowload_warning`](alertmanager://remote-buddy-platform/rules/probe_queue_lowload_warning)<br>• PromQL — [`avg_over_time(probe_queue_lowload_latency_ms[10m])`](promql://probe_queue_lowload_latency_ms/avg)<br>• Evidence (2026‑02‑24 00:40 UTC) — [Probe export](notion://pushpals/ops-journal/remote-queue-low-load-2026-02-24#probe) | ≥ 750 ms or ≥ 2 drops/20 → roll back the last lever and re-check upstream dependencies.<br>• Grafana panel — [Synthetic Queue Probes › `queue_lowload`](grafana://d/remotebuddy-synth/probe?viewPanel=queue_lowload)<br>• Alert rule — [`probe_queue_lowload_page`](alertmanager://remote-buddy-platform/rules/probe_queue_lowload_page)<br>• PromQL — [`avg_over_time(probe_queue_lowload_latency_ms[10m])`](promql://probe_queue_lowload_latency_ms/avg)<br>• Evidence (2026‑02‑24 00:40 UTC) — [Probe export](notion://pushpals/ops-journal/remote-queue-low-load-2026-02-24#probe) |

Update the table with fresh sources (new Grafana panel IDs, new alert names, or evidence timestamps)
instead of layering new paragraphs elsewhere. That ensures every future reader sees one canonical
set of numbers.

## Monitoring + tooling

| Surface | What to inspect | Access / notes |
| --- | --- | --- |
| Grafana › RemoteBuddy Queue Overview | `queue_p95`, `requests_pending`, `jobs_pending`, backlog shape. | Pin last 15 min vs 24 h, export snapshot links for the table above. |
| Grafana › Worker Backends Latency | Worker RPC p95/p99, upstream saturation, idle slots. | Confirms whether queue inflation started upstream before spending time on WorkerPals. |
| Alertmanager quick view | Active `queue_*`, `worker_idle_*`, probe alerts. | Link alerts to the threshold table row when posting in `#pushpals-ops`. |
| Server `/system/status` API | `queues.requestPendingSnapshot`, `queues.jobPendingSnapshot`, worker idle counts, SLO digests. | `curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status \| jq '{queues, slo}'` |
| Client Ops board (`bun run client:only` → Ops tab) | Real-time ETA overlay + retry notifications. | Use when deciding whether to pause background/eval submissions. |
| WorkerPals logs (`bun run workerpals:only[:docker] -- --tail`) | `task.execute` retries, wrapper timeouts, stuck workers. | Combine with `/workers` heartbeat to prove capacity additions had effect. |

## Tuning levers (link to config + owner)

Only adjust one lever at a time and wait three measurement intervals before tagging the next. Use
the registry below to find the canonical config/code path, the accountable owner, and the default
entry point before diving into the per-lever procedures.

| Lever / flag | Canonical config path(s) | Owner (Slack / PagerDuty) | Execution entry point |
| --- | --- | --- | --- |
| Worker allocation per lane | [`configs/default.toml`](../../../configs/default.toml) (`[remotebuddy]`, `[workerpals]`); [`apps/workerpals/src/workerpals_main.ts`](../../workerpals/src/workerpals_main.ts) | [Slack `@workerpals-oc`](slack://user/@workerpals-oc) / [PagerDuty WorkerPals Runtime](pagerduty://schedules/workerpals-runtime) | `bun run workerpals:only -- --lanes <lane=m>` (record command) |
| Lane throttles (background/eval deferral) | [`apps/server/src/requests.ts`](../../server/src/requests.ts); [`apps/remotebuddy/src/remotebuddy_main.ts`](../src/remotebuddy_main.ts) | [Slack `@remote-queue-oc`](slack://user/@remote-queue-oc) / [PagerDuty RemoteBuddy Platform](pagerduty://schedules/remotebuddy-platform) | `curl …/requests/enqueue` to force worker lane; LocalBuddy Admin throttle toggle |
| Deterministic lane prefetch toggle | [`apps/remotebuddy/src/brain.ts`](../src/brain.ts); [`prompts/remotebuddy/remotebuddy_system_prompt.md`](../../prompts/remotebuddy/remotebuddy_system_prompt.md) | [Slack `@remote-queue-oc`](slack://user/@remote-queue-oc), [Slack `@safety-review`](slack://user/@safety-review) / [PagerDuty RemoteBuddy Platform](pagerduty://schedules/remotebuddy-platform) | Planner override change (`requires_worker=false`, `lane="deterministic"`) |
| Autonomy `forceWorker` remediation rate | [`configs/default.toml`](../../../configs/default.toml) (`[remotebuddy.autonomy]`); [`apps/remotebuddy/src/autonomous_engine.ts`](../src/autonomous_engine.ts) | [Slack `@remote-autonomy`](slack://user/@remote-autonomy) / [PagerDuty Remote Autonomy](pagerduty://schedules/remote-autonomy) | `remotebuddy.autonomy.max_dispatch_per_hour=<n>` + `bun run remotebuddy:only` |
| Queue priority weights/budgets | [`apps/server/src/jobs.ts`](../../server/src/jobs.ts) | [Slack `@server-core`](slack://user/@server-core), [Slack `@remote-queue-oc`](slack://user/@remote-queue-oc) / [PagerDuty Server Core](pagerduty://schedules/server-core) | Edit `JOB_PRIORITY_QUEUE_SLA_MS` + `bun run server:only --env-file .env` |

### 1. Worker allocation per lane

- Config reference: [`configs/default.toml` (`[remotebuddy]` & `[workerpals]`)](../../../configs/default.toml) and [`apps/workerpals/src/workerpals_main.ts`](../../workerpals/src/workerpals_main.ts).
- Owner: WorkerPals Runtime ([Slack `@workerpals-oc`](slack://user/@workerpals-oc), [PagerDuty WorkerPals Runtime](pagerduty://schedules/workerpals-runtime)).
- How to:
  1. Launch one extra worker per stressed lane: `PUSHPALS_AUTH_TOKEN=… bun run workerpals:only -- --lanes interactive=4,normal=2,background=1` (increase/decrease counts symmetrically).
  2. Confirm `/system/status` shows ≥ 3 idle slots per lane before ending the change.
  3. Document the invocation + timestamp in the on-call thread so rollback just reverses the same command.

### 2. Lane throttles (background/eval deferral)

- Config reference: [`apps/server/src/requests.ts`](../../server/src/requests.ts) (`forceWorker`, `forceLane` fields) and [`apps/remotebuddy/src/remotebuddy_main.ts`](../src/remotebuddy_main.ts) (lane selection).
- Owner: RemoteBuddy Platform ([Slack `@remote-queue-oc`](slack://user/@remote-queue-oc), [PagerDuty RemoteBuddy Platform](pagerduty://schedules/remotebuddy-platform)).
- How to:
  1. Pause background/eval submissions by forcing new requests onto the worker lane: 

     ```bash
     curl -sS -X POST http://localhost:3001/requests/enqueue \
       -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"prompt":"pause background","priority":"background","forceLane":"worker","forceWorker":true,"metadata":{"throttle":"queue-low-load"}}'
     ```

  2. If LocalBuddy is injecting traffic, toggle its Admin throttle to `interactive-only` and note when you resume (5-job increments once `queue_p95` ≤ 0.6 s).
  3. Keep a list of deferred job IDs in the incident thread so they can be replayed once the queue stabilizes.

### 3. Deterministic lane prefetch toggle

- Config reference: [`apps/remotebuddy/src/brain.ts`](../src/brain.ts) (planner overrides) and [`prompts/remotebuddy/remotebuddy_system_prompt.md`](../../prompts/remotebuddy/remotebuddy_system_prompt.md) (`requires_worker` policy).
- Owner: RemoteBuddy Platform + Safety ([Slack `@remote-queue-oc`](slack://user/@remote-queue-oc), [Slack `@safety-review`](slack://user/@safety-review), [PagerDuty RemoteBuddy Platform](pagerduty://schedules/remotebuddy-platform)).
- How to:
  1. When worker bandwidth is scarce, reroute lightweight prompts by explicitly setting `requires_worker=false` and `lane="deterministic"` through the planner overrides.
  2. Confirm the deterministic lane handles those prompts in ≤ 200 ms before leaving the knob in place (attach evidence from the synthetic probe panel).
  3. Roll back by restoring the original planner overrides (set `requires_worker=true` or remove the override block) and posting the reversal time in the ops thread.

### 4. Autonomy `forceWorker` remediation rate

- Config reference: [`configs/default.toml` (`[remotebuddy.autonomy]`)](../../../configs/default.toml) and [`apps/remotebuddy/src/autonomous_engine.ts`](../src/autonomous_engine.ts) (`max_dispatch_per_hour`, `queue_health` logic).
- Owner: RemoteBuddy Autonomy DRI ([Slack `@remote-autonomy`](slack://user/@remote-autonomy), [PagerDuty Remote Autonomy](pagerduty://schedules/remote-autonomy)).
- How to:
  1. Tighten the dispatch budget when automation is over-enqueuing by dropping `remotebuddy.autonomy.max_dispatch_per_hour` to 3 via `configs/local.toml` or a temporary env override.
  2. Restart RemoteBuddy (`bun run remotebuddy:only`) so the new limit applies, then watch the `forceWorker` metadata in `/requests?status=pending` to confirm the rate change.
  3. Restore the default (6) once backlog and idle slots return to baseline.

### 5. Queue priority weights and budgets

- Config reference: [`apps/server/src/jobs.ts`](../../server/src/jobs.ts) (`JOB_PRIORITY_ORDER`, `JOB_PRIORITY_QUEUE_SLA_MS`).
- Owner: Server + RemoteBuddy Platform ([Slack `@server-core`](slack://user/@server-core), [Slack `@remote-queue-oc`](slack://user/@remote-queue-oc), [PagerDuty Server Core](pagerduty://schedules/server-core)).
- How to:
  1. If interactive latency creeps upward despite low backlog, temporarily bump the interactive SLA by editing `JOB_PRIORITY_QUEUE_SLA_MS.interactive` and restarting the server: `bun run server:only --env-file .env`.
  2. Keep the change local (commitless) and note the diff/sha in the ops thread.
  3. Roll back by re-checking the file from `main` or via the rollback procedure below as soon as p95 returns < 0.7 s.

## On-call response flow

1. **Prove the alert window** by exporting the Grafana queue snapshot + `/system/status` JSON referenced in the threshold table, pinning both links to the active `#pushpals-ops` thread.
2. **Confirm traffic really is “low-load”** (≤ 35 interactive RPS, ≤ 10 eval/background RPS). If the traffic window is higher, switch to the primary incident guide in `apps/remotebuddy/docs/queue.md`.
3. **Pick exactly one lever** from the section above, tag the owner listed for that lever, and record the command/override you applied in the thread together with the evidence links used for the decision.
4. **Measure for three intervals** (minimum 5 minutes) before stacking another change. If a rollback trigger hits, jump directly to the rollback procedure instead of experimenting further.
5. **Escalate** when `queue_p95` ≥ 0.9 s or idle slots fall below the rollback trigger even after undoing the most recent change; page RemoteBuddy Platform first, then WorkerPals Runtime if capacity is at fault.

## Rollback procedure (config + deployment)

When a rollback trigger fires, stop changing levers and follow these reproducible steps:

**Pre-checks (capture current state before overwriting config)**

```bash
git status --short configs/default.toml configs/local.toml
curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status \
  | jq '{queue_p95: .slo.requests.queueWaitMs, pending: .queues.requests.pending, idle: .workers.idle}'
```

1. Discover and select the last known-good tag. Pick the newest `remotebuddy-queue-lowload-*` tag that predates the current incident window and matches the evidence timestamps in the baseline table:

   ```bash
   git fetch --tags origin
   git tag -l 'remotebuddy-queue-lowload-*' --sort=-creatordate | head -n 5
   export RB_QUEUE_TAG=remotebuddy-queue-lowload-20260224
   ```

2. Inspect the tagged config so you know what will be restored:

   ```bash
   git show $RB_QUEUE_TAG:configs/default.toml | sed -n '/^\[remotebuddy\]/,/^\[/p'
   git show $RB_QUEUE_TAG:configs/default.toml | sed -n '/^\[workerpals\]/,/^\[/p'
   ```

3. Backup current overrides, then restore the tagged values:

   ```bash
   ts=$(date +%Y%m%d%H%M%S)
   cp configs/default.toml configs/default.toml.$ts.bak
   cp configs/local.toml configs/local.toml.$ts.bak 2>/dev/null || true
   git checkout $RB_QUEUE_TAG -- configs/default.toml
   git checkout $RB_QUEUE_TAG -- configs/local.toml 2>/dev/null || true
   ```

4. Restart the services so the restored config applies:

   ```bash
   bun run server:only > /tmp/server.log 2>&1 &
   bun run remotebuddy:only > /tmp/remotebuddy.log 2>&1 &
   bun run workerpals:only:docker > /tmp/workerpals.log 2>&1 &
   ```

**Post-checks (prove rollback succeeded before closing the loop)**

```bash
curl -sS -H "Authorization: Bearer $PUSHPALS_AUTH_TOKEN" http://localhost:3001/system/status \
  | jq '{queue_p95: .slo.requests.queueWaitMs, pending: .queues.requests.pending, idle: .workers.idle}'
```

5. Post the tag, command log, and `/system/status` snapshot in the PagerDuty incident + `#pushpals-ops` thread.

## Incident follow-up checklist

Complete these items once mitigation stabilizes (even if p95 stays healthy):

1. **File the follow-up ticket** in the Ops tracker with the following required fields:

   | Field | Required value |
   | --- | --- |
   | Project / Board | `OPS` (RemoteBuddy Platform) |
   | Title | `RemoteBuddy queue tuning – <YYYY-MM-DD HH:MM UTC>` |
   | Component | `RemoteBuddy Queue` |
   | Severity | `S2 – Degradation` |
   | Primary assignee | Current RemoteBuddy Platform on-call (`@remote-queue-oc`) |
   | Due date | Next business day 17:00 PT (enter explicit date, e.g., `2026-02-26`) |
   | Attachments | Grafana snapshot, `/system/status` JSON, WorkerPals log bundle |

2. **List every lever touched** (command + timestamp + outcome) inside the ticket description and link back to this playbook section.

3. **Assign follow-up owners** for deferred work (e.g., replaying paused background jobs) and note the Slack handle plus PagerDuty schedule in the ticket.

4. **Schedule a verification reminder** (calendar or Linear/Jira reminder) for the due date so the assignee confirms the queue stayed within the baseline window or files a new incident if regression reappears.

5. **Close the incident communication loop** by dropping the ticket link + due date into the resolved `#pushpals-ops` thread and updating the PagerDuty timeline.

Keeping this checklist updated avoids vague "follow up later" notes and ensures every queue tuning
exercise ends with an auditable artifact.
