# v1.2.56 throughput investigation

## Evidence and scope

Read-only inspection of the SectorCommand run starting at
`2026-09-27T21:07:01.682Z`, with a database snapshot around
`2026-09-28T01:01Z`. Changes made from these observations are generic PushPals
behavior, not repository-specific paths, commands, or task selection rules.
The running installation and user repository were not modified for validation.

## What was slow

Four jobs had completed, with zero failed jobs and three merged PRs. One job was
a review repair for the first PR, so job count is not distinct delivered work.

| Job                          | Worker execution | Claim to publication completion | Trusted-host validation |
| ---------------------------- | ---------------: | ------------------------------: | ----------------------: |
| Initial documentation change |           7m 05s |                         14m 16s |                  4m 56s |
| Review repair                |           3m 30s |                          8m 38s |                  4m 32s |
| Token-redaction change       |           5m 56s |                         10m 53s |                  4m 34s |
| Fixture/diagnostic change    |           7m 21s |                         12m 39s |                  4m 49s |

Average worker execution was about six minutes; claim-to-publication averaged
11m 36s. Registered-worker utilization was approximately 5.6%, estimated from
23.9 busy minutes over 428.2 registered-worker minutes. This is a phase-derived
estimate, not CPU utilization. New autonomous requests were approximately
75 and 80 minutes apart.

The main bottleneck was discovery, not worker concurrency:

- Forty-seven autonomy ticks ran at the configured five-minute cadence.
- Thirty-seven fresh RepositoryAgent analyses and nine positive-cache replays
  produced only three new autonomous requests; one tick deferred for capacity.
- Fresh empty results did advance bounded evidence pages, but each advancement
  waited for the next normal tick. Fresh analysis averaged about 40 seconds.
- Positive answers for already active/recent work were replayed and rejected
  downstream instead of exploring another page.
- Tree/outcome changes restarted the discovery cursor. Unchanged reviewed
  evidence lost its place even though stale candidate facts correctly needed
  invalidation.

The required aggregate validation was already deferred by ValidationGate in
zero milliseconds and executed once per candidate by the trusted host. There
was no repeated host-validation retry to remove. The initial cold dependency
install took 106 seconds; subsequent installs were roughly half a second.
Runnable worker child gates remained useful. Some editing passes nevertheless
ran a full suite and retried known sandbox-unavailable checks before those
authoritative gates, duplicating work.

## Changes derived from the evidence

- Schedule bounded 30-second discovery follow-ups after durable empty/excluded
  page progress, only with verified idle capacity. Recheck all safety, budget,
  publication, and lock gates. Keep normal cadence after dispatch because a
  pending planning request may not yet appear in worker job counts.
- Persist reviewed-page Git blob fingerprints across unrelated revisions and
  outcomes. Keep exact candidate-cache invalidation and snapshot verification.
- Apply active/recent target exclusions to delivery, not structural truth;
  defer an all-excluded page only for that exclusion set, preserving viable
  siblings and the original reusable cached answer.
- Direct initial editing passes to focused validation and explicit capability
  limits, while retaining mandatory full/trusted-host checks.
- Apply capability preflight to parallel fast-validation batching as well as
  sequential validation; a fast-looking script name does not prove its
  dependencies can run in the sandbox.
- Expose bounded discovery progress separately from model output and preserve
  it across the durable broker/client boundary.

## Acceptance and limitations

Regression coverage exercises progress across outcome changes and restarts,
changed evidence/vision invalidation, exclusion removal and mixed candidates,
CAS/deadline failures, unavailable telemetry, timer collisions, pause/shutdown,
and unchanged validation requirements. Validation ran in the existing Docker
fixture capped at one CPU, 768 MiB, and 512 PIDs, not host services:

- Rebuilt CLI bundle and verified the 276-file package payload.
- Full root suite after rebuilding generated assets: 2,900 passed, 12 skipped,
  zero failed; 16,231 assertions across 193 files.
- Python executor suite: all 134 tests passed.
- RemoteBuddy, WorkerPals, and shared-package typechecks passed; changed-file formatting and
  diff checks passed.

The skipped tests require Windows or additional real-container/image fixtures.
This does not substitute for a Windows live soak or post-release throughput
measurement. The first full run correctly rejected stale generated runtime
copies in the reused fixture; rebuilding the package resolved both parity
failures before the successful full rerun.

These changes reduce measured sources of waiting and duplicated work; they do
not establish a new live-run throughput number, guarantee every task finishes
within ten minutes, or justify generating ungrounded work. Full publication
validation and PR review remain real costs and quality requirements. Compare
future runs using distinct merged PRs, worker utilization, discovery page/cache
outcomes, first-review acceptance, and end-to-end latency, not job count alone.
