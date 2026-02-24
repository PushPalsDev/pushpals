# RemoteBuddy Queue Tuning & Rollback Playbook

_Last updated: 24 February 2026 — low-load profile: `queue_p95` **533 ms**, failures **0** (rolling 24 h)._ 

Use this playbook when RemoteBuddy queue wait is drifting from the low-load target but still
below paging thresholds. It codifies how we monitor the zero-failure steady state, which knobs
we can safely turn, and the hard lines that trigger rollback and escalation. The numbers in
this edition come from the 23–24 February low-load window and supersede the December 2025
defaults in the generic incident guide.

## Baseline Metrics

The 23-24 February low-load window locked our reference stats: `queue_p95` steady at 533 ms
with zero job failures. Treat that pairing as the success contract for every lever below; as
soon as either number drifts, stop tuning and prepare to rollback. Keep this at-a-glance
picture pinned in the on-call thread before changing anything:

- **Low-load contract**: `queue_p95` 533 ms ± 75 ms and `jobs.failed` still 0.
- **Traffic window**: ≤ 35 interactive RPS and ≤ 10 eval/background RPS.
- **Queue feel**: backlog < 10 per lane with ≥ 3 idle workers in `/system/status`.

- **p95 latency**: `queue_p95` holds at 533 ms (0.4–0.6 s typical) when we have ≤ 35 interactive RPS and ≤ 10 background/eval RPS. Treat > 600 ms as “investigate” and ≥ 800 ms as “tune a lever now.”
- **Failures**: zero failed jobs in `/system/status` snapshots and Alertmanager; any increment is a red flag, not a tuning target.
- **Backlog shape**: backlog < 10 items per lane at rest with ≥ 3 idle workers. Backlog 10–15 can be normal immediately after batched submissions; anything beyond 15 at low load means capacity or throttles need attention.
- **Worker utilization**: WorkerPals processes finish `task.execute` within 1.1 s and keep ≥ 3 idle slots per lane. Sliding below 3 slots for multiple polls suggests queue pressure despite “low load.”
- **Confidence band**: Stay inside ±75 ms around the 533 ms p95 when validating a change. If the variance is wider even without alerts, assume the lever added jitter and consider rolling back early.

This baseline anchors the decisions in the sections below; if traffic is materially higher, jump to the main incident guide instead of this low-load procedure.

## Monitoring Signals

| Surface | What “normal” looks like (low-load) | Drift to watch for |
| --- | --- | --- |
| Grafana › RemoteBuddy Queue Overview | `queue_p95` 0.4–0.6 s, backlog < 10 across lanes | p95 trending ≥ 0.8 s for >5 m or backlog climbing > 15 without matching traffic spike. |
| `/system/status` API (`queues.*Snapshot`) | Interactive wait ≤ 600 ms, background jobs ≤ 900 ms, zero failed jobs | Idle slots falling < 3 per lane, any `jobs.failed` increment, or approvals aging > 5 m. |
| WorkerPals runtime logs | `task.execute` completes ≤ 1.1 s, no retry bursts | Retries > 3/minute, `busy` workers pinned > 2 minutes, or wrapper timeouts chaining. |
| Alertmanager quick view | No open `queue_p95_*` alerts | Warning alerts reopening after manual tuning → indicates regressing knobs. |
| Synthetic queue probes | `probe.queue_lowload` round trip < 550 ms, zero drops | Probe ≥ 650 ms for two consecutive runs or any dropped probe in last 20 samples. |

Always compare the last 15 minutes to the trailing 24 hours so small swings don’t get mistaken
for regressions during quiet hours.

## Tuning Levers

1. **Worker allocation**: Scale WorkerPals processes per lane (`bun run workerpals:only[:docker]`)
   in ±1 increments; validate `/workers` shows ≥3 idle slots before ending the change.
2. **Lane throttles**: Pause or rate-limit background/eval submissions through Admin console or
   LocalBuddy when backlog > 15; resume gradually (5-job increments) once p95 returns ≤ 600 ms.
3. **Batch sizing**: Adjust queue batch pull size (`QUEUE_PULL_BATCH`, default 10) upward when
   workers are underutilized; revert if interactive latency rises > 100 ms.
4. **Prefetch windows**: Toggle deterministic lane prefetch (`requires_worker=false`) to offload
   lightweight prompts from worker queues during tuning runs.
5. **Retry budgets**: Temporarily lower client retry attempts (feature flag `retry_budget_low`)
   if WorkerPals logs show cascading retries; re-enable defaults immediately after stability.
6. **Queue priority weights**: Bump interactive weight by +1 (relative) when latency creeps above
   600 ms even though backlog is stable; revert once p95 settles back within the ±75 ms band.

Document every lever change in `#pushpals-ops` with timestamp, expected impact, and rollback path.

## Rollback Triggers

- `queue_p95` ≥ 0.9 s for 5 consecutive minutes after a tuning change.
- Interactive backlog ≥ 20 or any user wait > 2 minutes.
- Worker idle slots < 2 per lane for > 3 polls.
- Any failed job count increment (`queues.jobPendingSnapshot.failed > 0`) post-change.
- Alertmanager flips from clear → warning twice in 30 minutes for the same knob.

When any trigger fires, revert the most recent lever change first. If the change is not obvious,
restore the entire queue config from the last known-good `apps/remotebuddy/config/queue.yaml`
revision (tagged in git) and notify on-call of the revert.

## On-Call Response Steps

1. **Snapshot telemetry**: Capture Grafana queue panels and `/system/status` output before
   touching knobs; store in the active `#pushpals-ops` thread.
2. **Validate load shape**: Confirm request volume really is “low load” (≤ 35 RPS interactive,
   ≤ 10 eval/background). If not, stop and hand off to the main incident guide instead.
3. **Apply one lever at a time**: Never bundle changes. Wait at least 5 minutes (or until three
   polling intervals pass) before evaluating success or stacking another adjustment.
4. **Track outcomes**: Log observed `queue_p95`, backlog, worker idle slots, and retry counts
   after each change so we can compare against the 533 ms baseline later.
5. **Rollback decisively**: If any rollback trigger trips, immediately revert the last change,
   re-measure for 5 minutes, and only then consider alternative levers.
6. **Escalate when needed**: Page RemoteBuddy Platform (PagerDuty) if rollback fails to recover
   p95 < 0.9 s within 10 minutes or if failures appear. Loop in WorkerPals Runtime if capacity
   is the suspected bottleneck.
7. **Document and follow up**: Close the thread with final metrics, note which levers worked,
   and file TODOs for automation or deeper fixes if we leaned on manual tuning for > 30 minutes.

Maintaining the 533 ms p95 / zero-failure profile hinges on disciplined tweaks and fast rollbacks.
Stick to this playbook so the steady-state queue remains predictable even during experimentation.
