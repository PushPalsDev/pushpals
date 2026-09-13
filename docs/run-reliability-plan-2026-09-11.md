# September 11 reliability and planning repair

## Observed baseline

The supplied run used v1.2.52 / Bun 1.3.14 on Windows. It did not include
commit `0676575`, which was pushed without a release. Investigation reads the
target repository and its SQLite databases without modifying them.

For jobs created since 2026-09-11T09:32:32Z, the observed database contains
21 completed publications, four execution failures, three publication blocks,
and one pending repair. Completed attempts average 19.6 minutes. A published
attempt is not proof of a first-pass approved or merged PR.

The read-only cohort report confirms 75% terminal delivery success (21/28),
19.6-minute mean and 14.9-minute median successful end-to-end duration, with
none of those successful jobs finishing within ten minutes. Execution to
handoff averages 9.3 minutes across 24 observations; terminal publication
processing/waiting averages another 10.5 minutes across 24 completions. Those
are different sample sets, not additive per-job percentiles. Provider records
confirm 16 merges; recorded review evidence shows first-pass approval for
16 of 18 reviewed PRs. The cohort also references an older PR, so associated
PR counts are not counts of newly created PRs. Continuous uptime is unknown.

Confirmed issues:

- Two publication blocks repeat the historical PR-base defect addressed by the
  unreleased commit. Another retained candidate conflicts during replay.
- Multiple local HTTP clients lose connectivity during validation. The supervisor
  kills SCM after short probe timeouts and labels the restart a native crash;
  recovery is reported at spawn, before readiness is established. The underlying
  Windows transport/resource cause is not established by these logs.
- Visual repairs repeatedly require screenshots that the restricted executor
  cannot produce. Installing a browser outside that restriction is not proof of
  an available in-agent browser or local-server capability.
- A deferred trusted-host command is counted as a failed validation. Failure
  matching collapses unrelated target sets to their common documentation file,
  deferring a repair repeatedly while four workers remain idle.
- Vision parsing interprets a non-goals heading as positive goals and drops
  wrapped bullet continuations. Empty Repository Agent candidate results are
  replaced with invented vision/filename tasks, including forbidden outcomes.
- Terminal classification scans nested artifacts/history and can mistake an
  actually published candidate for a no-change result. The new report exposed
  this on a real published job; outcome evidence must exclude embedded logs.

Additional isolated reproductions and review findings:

- On Bun 1.3.14, a silent reused HTTP socket can cause a health timeout while a
  fresh connection succeeds. Health checks now avoid connection reuse.
- A wire-level Bun 1.3.14 reproduction shows that canceling an oversized upload
  and sending `Connection: close` can still leave a reusable socket containing an
  unfinished request body. Normal oversized uploads now drain to EOF before
  rejection, with independent time and byte limits. A sender that cannot finish
  within those limits must abandon its connection; fresh health connections do
  not rely on that socket. This does not claim to fix Bun's native close behavior.
- Alternating transport and explicit HTTP failures must not reset the outage
  clock indefinitely. Termination returning does not prove a process exited;
  failed termination must allow a later bounded retry.
- Aggregate restart testing also exposed `SQLITE_BUSY` during EventStore WAL
  initialization. A startup-only, bounded busy handler now tolerates transient
  locks, restores the previous runtime policy, and closes failed initializations.
  Separate-process tests cover both transient and persistent locks.

## Implementation plan

1. Preserve explicit empty repository advice, negative requirements, ranked
   priorities, and complete wrapped instructions. Admit only grounded targets.
2. Detect repeated unavailable visual-evidence capability without relaxing
   sandbox policy, quality thresholds, or evidence requirements. Retain useful
   candidates and stop cloning the same impossible repair.
3. Distinguish explicit unhealthy responses from bounded transport outages;
   report degraded/restarting/healthy states and confirm actual recovery.
4. Correct failure-circuit evidence and target matching. Keep unrelated work
   eligible and expose execution/publication/review outcomes separately.
5. Exercise the defects in portable regression fixtures, real temporary Git and
   SQLite state, and resource-capped container tests. Validate generated runtime
   assets and inspect the final changes independently.

## Acceptance and limits

- Negative vision requirements never become positive objectives; an empty
  grounded result does not dispatch fabricated work.
- Deferred checks are neither passes nor failures. Recovered test failures,
  baseline probes, and incidental shared paths do not freeze unrelated work.
- A missing browser capability cannot become a successful visual-validation
  claim. Code-only fixture passes cannot substitute for required screenshots.
- Runtime recovery requires observed readiness; null/unknown telemetry stays
  unknown. Deadlines, claim fencing, and bounded restart limits remain enforced.
- Tests and packaged-runtime verification must be reported with actual results.
  A live Windows soak and first-pass PR review remain separate evidence.

No code change can guarantee 100% future job success or uptime. The next
installed run must actually contain these changes; running v1.2.52 again will
not test them. This work does not silently publish a release or modify the
target repository's historical job outcomes.

## Implemented behavior

- Planning preserves non-goals, wrapped requirements, and grounded empty
  Repository Agent results. Generic fixtures cover these rules without encoding
  a target repository's product priorities in PushPals.
- Failure cooldowns require executed validation evidence and matching complete
  target sets. A later pass clears a previous failure; a host-validation deferral
  does not invent one. Capability holds fence the exact repair/PR head, retain
  candidates, and leave unrelated jobs claimable.
- Repeated unavailable browser evidence stops the futile revision cycle without
  approving missing screenshots. This does not provision an agent-accessible
  browser; those jobs still need a capable environment or explicit intervention.
- Health supervision uses fresh connections, tolerates bounded transport outages,
  and reports recovery only after readiness. Startup SQLite lock recovery and
  bounded oversized-request draining have real process/socket regressions.
- Terminal outcomes exclude embedded historical logs. The read-only
  `scripts/run-health-report.ts` separates delivery, review, merge, and latency
  evidence, and leaves unavailable uptime data unknown.

## Validation results

Validation uses Bun 1.3.14 in an owned Linux Docker container capped at one CPU,
768MiB memory, and 512 PIDs. No live target-repository workers were started and
the target repository's SQLite state was not modified.

- Full suite: `bun test tests --timeout 15000` passed 2,469 tests across 182 files,
  with 14,300 assertions, zero failures, and 12 skips (281.33 seconds).
- Reliability harness: all seven phases passed (299.674 seconds), including the
  Python worker watchdog, real Git/SQLite recovery, and HTTP runtime boundaries.
- TypeScript checks passed for Server, RemoteBuddy, WorkerPal, and
  SourceControlManager.
- CLI bundle build passed; package payload verification passed for 274 files.
  Tracked embedded-runtime assets were regenerated from the tested sources.
- Source formatting and `git diff --check` passed.

The skipped tests require Windows-specific sandbox/process/worktree behavior or
opt-in worker-image/nested-Docker integration. A long Windows soak, successful
live screenshot capture, and improved next-run latency/first-pass merge rates
remain unverified; passing portable regressions is not evidence for those claims.
