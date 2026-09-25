# September 24 cold-start observations

## Scope

Observe the supplied SectorCommand run without changing its repository, database,
configuration, running processes, or installed CLI. Implement generic fixes in
PushPals only. Times below are UTC. Observation ran for 30 minutes, from 01:46
through 02:16.

## Evidence

- The user ran `pushpals --clear`, which removed the shared worker image and
  repository-local runtime state, then started CLI v1.2.52 / Bun 1.3.14 at
  01:43:58. The installed release does not contain the newer `0676575` or
  `a8be77d` fixes already on PushPals `main`.
- At 01:44:08 the first WorkerPal began a cold Docker image build. At 01:46:05,
  RemoteBuddy terminated it for missing its 120-second online deadline. Its
  replacement started another build at 01:46:13 and hit the same deadline.
- Source code gives image builds and pulls a ten-minute command budget, but
  the parent readiness deadline did not account for that preparation phase.
  Build output was buffered until completion, leaving no useful live progress
  between "building" and termination.
- At 01:48:13, both Server and SourceControlManager returned HTTP 200. SCM
  reported fresh completed ticks, zero publication backlog, and no degraded
  components. These samples do not prove continuous uptime.
- At 01:49:21, the read-only database contained zero workers and zero jobs, with
  one claimed request awaiting handoff. This is blocked worker startup, not a
  failed or successful completed job.
- At 01:50:30 the first request failed with `WorkerPal backend unavailable`; the
  second request failed at 01:54:39 for the same reason. At 01:58:20 six worker
  startup timeouts had been logged and no worker had registered. A ten-minute
  command limit was never reached: the parent repeatedly intervened first.
- At 02:00:50, both service health checks still returned HTTP 200 while the
  worker timeout count reached eight. A responsive control plane therefore did
  not establish that the system could execute jobs.
- Repository Agent returned no structured candidates; v1.2.52 manufactured
  fallback candidates anyway. That behavior is already corrected on `main`.
  The dispatched control-panel objective is broadly consistent with the vision,
  but a broad objective is not evidence of a concrete unresolved code defect.
- The persisted first Repository Agent answer explicitly explains its empty
  result: supplied snippets show safeguards already implemented, while truncated
  test files and an omitted control-panel implementation do not establish a new
  defect. It recommends more complete relevant evidence. This is a valid
  uncertainty result, not a model crash. A bounded second evidence-gathering pass
  is a follow-up opportunity; this patch does not invent candidates or implement
  a new repository-retrieval strategy.

## Repair approach

1. Recognize explicit, structured image-preparation phases when waiting for a
   worker. Keep online readiness authoritative; a build marker is not a ready
   worker.
2. Honor the existing bounded image-preparation budget, including legitimate
   quiet build steps. Repeated markers or output must never extend an absolute
   startup ceiling.
3. Report image phase, elapsed time, and observed output volume without exposing
   raw command output or pretending timer ticks are build progress.
4. Preserve bounded output handling and cleanup. Add regression coverage for
   normal startup, long/quiet cold builds, stalled builds, malformed output,
   process exit, and real online confirmation.
5. Validate in an isolated, resource-capped container; do not restart the user's
   run to test source changes. Release/install and a new-run cold-start check
   remain separate from this observation task.

## Observability and review

The read-only health report now includes request-status counts in their own
creation-time cohort. This exposes failed requests even when no jobs exist.
Request completion never becomes a job/publication success; missing history is
unknown and per-table row caps explicitly mark incomplete samples.

Independent review caught malformed marker coercion and cancellation bookkeeping
that could accumulate per-output-chunk handlers. Both were corrected with
regressions before aggregate validation. Tests also cover a quiet 150-second
build surviving the old 120-second registration deadline, joining an existing
warmup for request dispatch, and a hung build reaching its fixed deadline.

## Initial validation (before the follow-up lifecycle review)

- Focused container run: 122 tests passed, zero failed, three opt-in Docker
  integration tests skipped; 598 assertions across seven files.
- RemoteBuddy and WorkerPal TypeScript checks passed.
- Full container suite: 2,495 passed, zero failed, 12 platform-specific/opt-in
  skips; 14,455 assertions across 184 files (269.44 seconds).
- CLI bundle build and 274-file package payload verification passed. Generated
  runtime bundles and the mirrored Docker executor were refreshed.
- The first harness run exposed a five-second default test timeout in the
  existing capability-hold SQLite fixture (6.44 seconds under aggregate load).
  It passed isolated in 1.27 seconds. That fixture now explicitly allows 15
  seconds for real WAL writes, reopen/migration checks, and synchronous cleanup;
  assertions and the 180-second lifecycle phase deadline are unchanged. This is
  not a change to any production job deadline or evidence gate.
- Final reliability harness: all seven phases passed (312.55 seconds); its
  runtime-boundary phase passed 570 tests with six opt-in/platform skips. These
  controlled validation results are separate from the unchanged live release.

## Limits

No new version was installed into the running session and no real cold image
build with the patched supervisor was attempted on the user's host. The
controlled startup tests establish deadline/readiness behavior, not that a
particular network, image build, or job will succeed. The interrupted old-release
builds cannot establish whether a separate build failure would occur later.
Windows soak results, job latency, and first-pass PR quality remain unverified
while no workers are registered and no jobs are executing.

## Observation outcome

At 02:16:13, the old release had logged 15 premature worker startup timeouts.
Both Server and SCM still returned HTTP 200; SCM had a fresh completed tick and
zero publication backlog. The final database snapshot contained two failed
requests, zero registered workers, and zero jobs. No job latency or PR-quality
claim can be made from that run. Periodic successful probes are not proof of
100% continuous uptime.

The source fixes, tests, and generated runtime assets remain local and
uncommitted. No release was created or installed, and the observed runtime was
left running unchanged. The owned capped validation container was stopped after
its checks completed.

## Follow-up lifecycle review and repairs

The second review found four gaps that the initial passing suite did not cover:

- A build that consumed its complete command timeout could lose its failure
  marker during process/stream cleanup. The parent then terminated the worker
  before its registry fallback, despite unused overall time.
- A successful image build left only the normal two-minute deadline for the
  complete Git/container/backend self-check. Mocked successful operations within
  their individual limits demonstrated that this composite phase can exceed it.
- A failed startup self-check could leave a detached warm container behind;
  process-tree termination alone cannot remove Docker-daemon-owned containers.
- An in-flight prewarm fetch could resume after disposal and spawn a worker
  outside the shutdown snapshot. A production-method mock reproduced one spawn
  after disposal and zero terminations.

The follow-up uses a shared supervisor/worker startup budget and explicit phases,
including bounded timeout cleanup and self-check time. Retries consume the same
absolute allowance. Startup cleanup runs before exit or direct fallback; the
supervisor reconciles exact worker-owned containers before freeing capacity.
Shutdown admission is fenced across asynchronous prewarm/spawn boundaries.

These are generic PushPals changes. No SectorCommand code, configuration, database,
or live service is changed. Focused lifecycle tests and packaging checks are
required in addition to the earlier aggregate results; a real Windows cold-start
and job-quality soak remain separate validation, not implied by mocked tests.

Additional review tightened two failure paths: cancelled work cannot borrow
permission from concurrent cleanup, and mixed "container absent"/permission
errors cannot authorize direct fallback. Exact-owned supervisor cleanup also
rejects truncated, undecodable, timed-out, or failed output captures. Subprocess
read failures now have explicit flags instead of appearing as successful empty
output. Cleanup retries do not signal an exited worker PID again.

Both image build and pull retain their existing ten-minute command limits. The
shared ceiling is the normal startup timeout plus 25.5 minutes, including the
five-minute self-check and cleanup grace (27.5 minutes with default settings).
This is a worst-case startup ceiling, not a delay applied to successful startup
or a change to job execution budgets.

### Follow-up validation

- Focused container suite: 180 passed, zero failed, three opt-in Docker skips;
  832 assertions across ten files.
- RemoteBuddy and WorkerPal TypeScript checks passed on the final sources.
- Full container suite: 2,561 passed, zero failed, 12 platform-specific/opt-in
  skips; 14,750 assertions across 188 files (236.63 seconds).
- CLI bundle build and 276-file package payload verification passed. Two new
  source files acquired executable bits when copied from the Windows bind mount
  into the disposable Linux clone; normalizing those fixture file modes to 0644
  resolved the initial package verification failure. The verifier was not weakened.
- Generated runtime assets were refreshed, including both startup helpers and
  the shared subprocess capture changes. The package gate now requires the new
  WorkerPal and shared startup files.
- The first follow-up harness run hit the five-second default deadline of the
  existing memory persistence/restart integration test (5.03 seconds). That case
  passed in the full suite (0.91 seconds) and isolated (1.96 seconds). Its two
  real server launches each allow 12 seconds internally, plus a three-second
  restart drain. Only this fixture now has a 35-second outer timeout; assertions,
  production deadlines, and the 300-second harness phase bound are unchanged.
- A subsequent attempt passed the first five phases, then stopped before the
  watchdog tests because this container provides `python3`, not `python`. The
  final harness invocation explicitly uses its supported `PYTHON=python3`
  override; no watchdog assertion or production interpreter selection changed.
- Final reliability harness: all seven phases passed (300.33 seconds). The
  runtime-boundary phase passed 636 tests, zero failed, six opt-in/platform
  skips; 3,149 assertions across 37 files. Formatting and diff checks passed.

All heavier validation ran in the existing isolated container capped at one CPU,
768 MiB, and 512 PIDs, with the PushPals source mounted read-only and no Docker
socket or SectorCommand mount. No new version was installed into the live run.
The validation container was stopped after the follow-up checks. At that point,
changes were local and uncommitted; no release had been created or installed in
the observed run. Subsequent publication is tracked in `release_log.md`.
