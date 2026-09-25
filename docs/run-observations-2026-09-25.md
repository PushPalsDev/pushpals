# September 25 startup and autonomy observations

## Scope

Observe the user's CLI v1.2.53 / Bun 1.3.14 session started at
2026-09-25T04:31:11Z. Times below are UTC. Read logs, read-only SQLite snapshots,
and service health endpoints; do not change the running installation, repository,
database, configuration, or processes. Implement generic fixes in PushPals only.
The user requested a commit and push, not another release or live upgrade.
The pre-commit observation window covers startup through 05:02:04 UTC
(approximately 31 minutes).

## Observed behavior

- Embedded runtime startup finished in 13.523 seconds; the CLI connected at
  04:31:33. The first server probe failed before its listener was ready, causing
  misleading degraded/restart advice. The server was healthy about three seconds
  later, without a crash or restart.
- WorkerPal image preparation completed in 49.205 seconds. The first worker was
  online at 04:32:13, approximately 61 seconds after CLI invocation. This run did
  not reproduce the previous repeated worker startup termination. Because this
  build finished within 120 seconds, it is not a live demonstration of the new
  longer-build deadline behavior.
- SourceControlManager reconciled the integration branch and reviewed/merged
  existing PRs. These are older PRs, not successful new jobs from this session.
- At 04:38:56, the server was responsive and SCM reported fresh completed ticks,
  no publication backlog, and no stalled provider poll. One worker was idle;
  the current database had no jobs or requests.
- The first two Repository Agent cycles completed in 44.452 and 36.723 seconds.
  Both returned zero candidates with six evidence references and no cache hit.
  Their persisted explanations explicitly say that truncated implementation and
  test excerpts do not establish a concrete unfinished task. The engine correctly
  refused to manufacture candidates. Zero created jobs is neither execution
  success nor execution failure, and does not establish successful job throughput.
- Old merged PR feedback repeatedly returned `ignored=true`. The server already
  retains missing-authority observations and waits for repeated observations plus
  ten minutes before acknowledging a permanent gap. During that wait, SCM logs
  omit the reason and classify the responses as provider failures. At 04:38:56,
  provider health was degraded with four failed polls despite responsive provider
  reconciliation; an explicit pending-authority state is more informative.
- At 04:48:30, the fourth planning cycle reused the cached empty analysis and
  completed in 6.813 seconds. Memory reuse works, but the same limited evidence
  cannot establish new work. A retrieval-version change prevents that old packet
  from being reused after the source fix is deployed.
- At 04:50:27, feedback for PRs #762 and #763 became permanent missing-authority
  acknowledgements and SCM completed their reconciliation. This demonstrates
  recovery, not an endless retry: the ten-minute minimum observation period plus
  exponential retry backoff took about 16 minutes for those old PRs.
- By 04:55:27, all seven old merged PRs (#762 through #768) had settled. SCM
  provider health returned to `ok`, consecutive failed polls returned to zero,
  and no degraded components remained. Historical failure-event counts remained
  visible; the source change distinguishes future pending-authority observations
  from genuine failures rather than erasing history.
- Two other existing PRs were explicitly skipped: #395 exceeded the diff review
  size cap and #593 had an empty diff. They were not successful new jobs and were
  not changed or closed by this observation task.
- At 05:02:04, all six Repository Agent requests had completed, with zero new
  jobs or user requests and one idle worker. Server and SCM health were good,
  SCM had fresh completed ticks and zero publication backlog, and all seven
  feedback tombstones were permanent. The sixth planning cycle again reused
  the empty analysis; the source evidence improvements are not installed in
  this still-running release.

## Changes

1. Report bounded initial transport refusal as startup, preserving launch limits,
   crash/restart behavior, explicit unhealthy responses, and post-readiness outage
   detection.
2. Distinguish explicitly deferred feedback authority from failed delivery. Keep
   pending feedback visible and retain retries; never treat arbitrary ignored,
   malformed, or failed responses as successful acknowledgement.
3. Improve bounded repository evidence coverage beyond file prefixes, preserving
   snapshot identity, original source coordinates, path security, total budgets,
   and the existing single synthesis stage. Invalidate old incomplete cache
   entries through the retrieval/prompt version rather than weakening grounding.

Independent review found and corrected an infinite startup-grace edge case and
contradictory feedback-disposition handling. Initial tests also exposed two
mis-shaped parameterized fixtures; those fixtures were corrected without
weakening assertions. Evidence regressions include short CJK retrieval terms,
UTF-8 boundaries, CRLF source coordinates, complete-line citation authority,
budget fairness, and body coverage beyond large headers.

## Validation

- Startup/recovery/SCM focused suite: 496 tests passed, zero failed.
- Evidence/autonomy focused suite: 171 tests passed, zero failed.
- Final feedback protocol suite: 272 tests passed, zero failed.
- RemoteBuddy, Server, and SourceControlManager TypeScript checks passed.
- Full `bun run test:root`: 2,614 passed, zero failed, 12 platform/opt-in skips;
  15,028 assertions across 189 files (251.35 seconds).
- Full `bun run harness:reliability`: all seven phases passed in 308.838 seconds.
  Windows-host and Docker-socket-dependent cases remain platform/opt-in skips
  inside this Linux container, not evidence of live Windows execution.
- CLI bundle and 276-file npm payload verification passed. RemoteBuddy, Server,
  and SCM packaged bundles were refreshed; generated output contains the new
  retrieval/cache version and feedback acknowledgement validation.
- All local execution uses an isolated container limited to one CPU, 768 MiB,
  and 512 PIDs. It has no Docker socket or SectorCommand mount. The source mount
  is read-only and tests execute in a disposable clone.

## Limits

The running release is unchanged while source fixes are developed. Static PR
review approval does not independently prove that required tests or browser
acceptance were executed. This observation does not change the configured
score-based review policy or provide a long-duration availability guarantee.
Successful new-job throughput remains unverified: no new jobs were dispatched
during this observation window. No SectorCommand-specific production logic was
added, and no live installation, runtime state, or repository content was changed.
