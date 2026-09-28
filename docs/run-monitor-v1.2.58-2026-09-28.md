# Eight-hour PushPals monitoring journal

Requested window: **2026-09-28 09:18–17:18 UTC** (02:18–10:18 Pacific).
Planned cadence: baseline, then every thirty minutes through the endpoint.
Status: **monitoring and follow-up implementation complete; final checkpoint at 17:18:24 UTC**.

## Scope and evidence rules

- Observe the existing SectorCommand run read-only: SQLite snapshots and bounded
  tails of its identified runtime/service logs. Do not restart, reconfigure,
  dispatch work, alter the live repository, or publish a release.
- Record new execution/queue/publication latency, provider-confirmed PR outcomes,
  actual review revisions, discovery progress, and evidence of crashes or stalls.
- Distinguish installed v1.2.58 from the unreleased fixes already in the PushPals
  worktree. Preserve those changes; this run does not validate them.
- Checkpoints are samples, not proof of continuous uptime. A bounded log tail can
  miss intervening events; stale quiet logs alone do not establish a dead service.
  Missing evidence stays unknown, and stopped/reset sessions are noted explicitly.
- After the monitoring window, review the accumulated evidence and implement/test
  justified repo-generic improvements. Do not manufacture changes if the evidence
  only confirms an already-fixed issue. No commit/release was requested here.

## Checkpoints

| Actual observation (UTC) | Jobs / publication | Capacity and discovery | Notes |
| --- | --- | --- | --- |
| 09:20:25 baseline | 1 completed job; 1 processed publication; PR 773 merged, score 9.2; no new jobs since 06:16 | 2 idle workers with fresh heartbeats; 53 completed opportunity analyses, 34 cache hits, 52 explicitly empty; latest page 16/16 exhausted and unadvanced | Runtime/server logs actively growing. No additional execution sample yet. Existing discovery starvation persists on installed v1.2.58. |
| 09:48:18 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 58 completed analyses, 39 cache hits, 57 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/16 ms); SCM backlog 0, provider failure events 0, same process/start time. Five additional cached empty analyses since baseline, without dispatch. |
| 10:18:12 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 64 completed analyses, 45 cache hits, 63 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/14 ms); SCM backlog 0, provider failure events 0. Six more cached empty analyses, no new execution sample in the first hour. |
| 10:48:13 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 70 completed analyses, 51 cache hits, 69 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (31/13 ms), backlog 0 at checkpoint. New transient health incident at 10:44, recovered without restart; details below. |
| 11:18:12 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 76 completed analyses, 57 cache hits, 75 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/15 ms), same SCM process, backlog 0, provider failure events 0. No further SCM log activity after the recorded 10:44 recovery. |
| 11:48:10 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 82 completed analyses, 63 cache hits, 81 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (31/14 ms), backlog 0, provider failure events 0. Six further cached empty analyses; no new SCM incident recorded. |
| 12:18:09 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 88 completed analyses, 69 cache hits, 87 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (34/14 ms), backlog 0, provider failure events 0. No additional execution sample after three hours. |
| 12:48:20 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 94 completed analyses, 75 cache hits, 93 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/14 ms), backlog 0. Bounded scan of the full current combined log since monitoring start found no incident after 10:44; matched lines remain 14 (one correlated incident, not 14 failures). |
| 13:18:18 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 100 completed analyses, 81 cache hits, 99 explicitly empty; page 16/16 unchanged | Halfway point: Server/SCM health 200 (34/16 ms), backlog 0, same SCM process. No additional incident in the combined log scan. |
| 13:48:24 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 106 completed analyses, 87 cache hits, 105 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/14 ms), backlog 0. No new incident in the combined log scan. |
| 14:18:17 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 112 completed analyses, 93 cache hits, 111 explicitly empty; page 16/16 unchanged | Five hours elapsed: Server/SCM health 200 (30/14 ms), backlog 0, no new incident in the combined log scan. |
| 14:48:19 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 118 completed analyses, 99 cache hits, 117 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (32/14 ms), backlog 0, no new incident in the combined log scan. |
| 15:18:20 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 124 completed analyses, 105 cache hits, 123 explicitly empty; page 16/16 unchanged | Six hours elapsed: Server/SCM health 200 (34/14 ms), backlog 0, same SCM process, no additional incident in the combined log scan. |
| 15:48:23 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 130 completed analyses, 111 cache hits, 129 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (31/14 ms), backlog 0, no new incident in the combined log scan. |
| 16:18:23 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 136 completed analyses, 117 cache hits, 135 explicitly empty; page 16/16 unchanged | Seven hours elapsed: Server/SCM health 200 (32/13 ms), backlog 0, no additional incident in the combined log scan. |
| 16:48:20 | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 142 completed analyses, 123 cache hits, 141 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (33/14 ms), backlog 0, no new incident in the combined log scan. Final checkpoint due 17:18 UTC. |
| 17:18:24 final | Unchanged: 1 completed/merged; no additional jobs or revisions | 2 fresh idle workers; 148 completed analyses, 129 cache hits, 147 explicitly empty; page 16/16 unchanged | Server/SCM health 200 (34/14 ms), backlog 0, same SCM process, routine integration maintenance active. No additional incident in the combined log scan. |

At 09:21:44, Server `/healthz` and SCM `/health` responded successfully. SCM was
idle with a tick completed roughly one second earlier, zero publication backlog,
and no reported provider failure events. Its quiet service log was not a stall.

Baseline job timing and the existing fixes are documented in
[the preceding investigation](run-observations-v1.2.58-2026-09-28.md).

### 10:44 transient health incident

The combined runtime log records two failed response-header health probes each for
SCM (first 10:44:23.169) and Server (first 10:44:24.180), with 2,500 ms
deadlines exceeded by only 2–12 ms. Two worker claim calls also hit their
6,000 ms timeout, and SCM's completion claim hit its 5,000 ms timeout. AI review
readiness briefly paused, then became ready at 10:44:30.416 without resetting
provider reconciliation. SCM recovered at 10:44:30.766 and Server at
10:44:31.779, both explicitly without process restart (observed failure durations
7,597 and 7,599 ms, not total measured outage durations). No jobs were active.
This is one correlated incident, not six independent service outages or failed
jobs. Its underlying cause is not established by these logs.

Read-only code inspection found that SCM `/health` uses an in-memory snapshot and
Server `/healthz` returns static JSON; the health handlers do not wait on each
other or query the database. Small supervisor deadline overruns are evidence that
the supervisor's timers fired promptly, not proof that either service event loop
was responsive. Service-side monotonic event-loop delay and bounded slow-stage
history would help distinguish blocking work from transport/host contention in a
future incident; consider that diagnostic improvement after the window.

## Findings to revisit after the window

1. Does the known exhausted-page replay remain the only cause of idle workers,
   or do new admission, lease, runtime, or publication blockers appear?
2. For any new jobs, separate editing, deterministic validation, critic,
   dependency setup, publication wait, and provider review/merge times. Do not sum
   overlapping phase or parallel-command durations.
3. Establish review quality from recorded provider/review evidence, not worker
   success alone. One historical merged PR is not a reliable mean or success-rate
   estimate for future jobs.
4. Audit `run-health-report.ts`: its first-pass merge-rate calculation may fail
   to mark incomplete provider-table evidence as unknown. This was identified
   during the metric audit, not observed as a live failure; verify and regression
   test it after the monitoring window if confirmed.

## End-of-window implementation and validation

### Observed outcome

- All sixteen scheduled follow-up checkpoints were taken, plus the baseline.
  The live runtime, queues, repository, and installed version were not changed.
- An exact read-only query for analysis creation times in `[09:18, 17:18)` found
  **96 completed opportunity analyses, all cache hits, all empty**. The baseline
  was sampled at 09:20, so its cumulative-to-final delta is 95 rather than 96.
  Do not add cumulative checkpoint counts together.
- **Zero new jobs, publications, PR reviews, or revision jobs** appeared during
  the window. The earlier job/PR 773 remained completed/merged. Consequently
  there is no new execution-latency distribution or first-pass-quality rate to
  estimate. The earlier job's 7m23s worker plus 7m11s publication is one sample.
- Two workers were idle with fresh heartbeats at every checkpoint; publication
  backlog was zero. The installed version continued replaying the exhausted
  six-file discovery page within its first 96 ranked paths. Existing unreleased
  window-advancement fixes directly address that observed starvation.
- One correlated transport incident was recorded during monitoring, at 10:44,
  and recovered without process restart. Subsequent bounded full-log scans
  (current combined log stayed below 4 MiB) found no other matching incident.
  The final log was about 1.29 MB. These are recorded events, not proof of exact
  uptime; the root cause of the brief stall remains unknown.

### Follow-up changes

1. Added generic Server/SCM runtime diagnostics: monotonic event-loop-delay
   samples and slow lifecycle reconciliation / integration maintenance /
   completion claim / completion-ref-GC operations. A small copied ring retains
   evidence after recovery, with rate-limited structured logs, no raw errors or
   payloads, and no database/network reads in the diagnostic health snapshot.
   This improves attribution; it does not claim to fix the unproven stall cause.
2. Corrected first-pass merge reporting: absent, unknown, partial, or truncated
   provider evidence now yields an unknown rate instead of implying failed
   merges. Approval-only metrics and confirmed observed counts remain intact.
3. Added deterministic diagnostic fault/lifecycle/bounds tests, live fixture
   health-route checks, and provider-evidence regression cases. Review removed
   an accidental health progress-clock reset so diagnostics do not change SCM
   liveness/restart behavior, and corrected fixed stage-label normalization.
4. Preserved the already-tested discovery-window, publication-triggered review,
   and Windows clear-speed improvements from the preceding tasks. No validation
   gate was removed to make timing look better; no repo-specific code was added.

### Validation

- **263 tests passed, zero failed, across ten files** in the resource-limited
  Docker fixture (one CPU, 768 MiB memory): report, runtime diagnostics, Server
  lifecycle/config/body/memory routes, SCM health/runtime/maintenance/review.
  The final combined run took 12.23 seconds. Counts include existing regressions;
  20 diagnostic and nine provider-evidence cases are new, along with two new
  service/lifecycle tests and an extended Server health assertion.
- Shared TypeScript checking passed. Server and SCM Bun builds passed.
- Independent review and re-review found no remaining concrete blockers after
  fixing diagnostic fault isolation, stage attribution, and the accidental
  liveness-clock mutation. Diagnostic failures cannot replace task results or
  errors, block shutdown through cancellation exceptions, or revive stale timers.
- Formatting and `git diff --check` passed for the follow-up changes. Heavy
  validation stayed inside Docker; no full PushPals stack was started on the
  host. The validation container was stopped after testing.
- Previous discovery/publication/clear regression results remain documented in
  the preceding investigation. This monitoring window ran installed v1.2.58,
  **not the patched code**; live throughput improvement and Windows diagnostic
  behavior still need validation in a new-version run. No live patched-version
  soak, commit, push, or release has been performed.
