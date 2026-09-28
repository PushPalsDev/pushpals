# v1.2.58 execution-speed observations

## Evidence and scope

Read the supplied startup log and the current SectorCommand SQLite database
using a read-only connection, plus matching bootstrap service logs. This is a
point-in-time investigation around 09:02 UTC on 2026-09-28, not a continuous soak
test. No live service, queue, checkout, or repository configuration was changed.
The implementation changes remain generic to PushPals repositories.

The run began at 05:57:31 UTC. At inspection there was exactly one job,
`68ea4645-9fce-4f8b-93de-290e74e927a4`, successfully published as PR 773 and merged
without revisions. Thus one successful sample cannot establish average job
latency or a success-rate guarantee.

## Timing breakdown

| Boundary                                | Observed time |
| --------------------------------------- | ------------: |
| CLI invocation to first worker claim    |        19m20s |
| Worker claim to completion handoff      |         7m23s |
| Handoff to confirmed publication        |         7m11s |
| Claim to confirmed publication          |        14m35s |
| Publication to provider-confirmed merge |           49s |

Worker evidence reports 23.4 seconds for dependency projection, 253.2 seconds
for the editing executor, 89.3 seconds for deterministic quality checks, and
38.2 seconds for the model critic. Those measurements are not a complete,
non-overlapping accounting of worker overhead. In particular, heuristic
log-derived phases are not precise command timings, and parallel validation
command durations must not be summed as wall-clock time.

Publication included a cold `bun install --frozen-lockfile` taking 106.2 seconds
(1,067 packages), followed by required `bun run validate` taking 301.2 seconds.
Each ran once, without a retry. The aggregate needs a Docker daemon unavailable
inside the worker sandbox and correctly ran on the trusted host. Its success
cannot safely be inferred from Linux worker checks or a different candidate SHA.
These mandatory gates are not removed by this speed change.

PR creation at 06:31:23.976 preceded review start at 06:31:42.526 by 18.6 seconds.
The review took 26.9 seconds, scored 9.2, and merge was confirmed at
06:32:14.698. The worker critic had scored the patch 9.3.

## Main throughput defect

After that merge, no further job was generated for more than 2.5 hours. The
RepositoryAgent repeatedly returned its cached empty page 16/16 at the regular
five-minute cadence. Its ranking contained 499 paths, but the sixteen-page cap
permanently restricted discovery to the first 96 additional paths. Healthy
services and idle workers did not imply productive job throughput.

## Changes and limits

- Continue durable discovery across bounded ranked-evidence windows, keeping six
  additional files per model request and sixteen pages per window. Preserve
  exact evidence/cache identity, exclusion handling, and compare-and-set progress;
  revisit earlier changed evidence instead of silently abandoning it.
- Permit the existing bounded idle-worker follow-up at a confirmed window
  transition. Final-page cache replay without that confirmation remains
  ineligible; resource, dispatch, and publication-backlog controls still apply.
- Nudge the existing review lane after confirmed publication and SCM cleanup,
  coalescing notifications without concurrent reviews or altered fairness.

These changes address idle time and publication-to-review latency. They do not
prove a shorter model-editing turn, eliminate the required five-minute host
validation, or guarantee that further evidence contains useful work. Regression
fixtures validate progress and lifecycle behavior; live effectiveness requires
a subsequent run of the changed build.

## Validation

In the resource-limited Docker fixture, the discovery/server suites passed 224
tests, followed by the added legacy-cache migration regression. Publication and
shared-client suites passed 109 tests; review-lane and reliability-harness suites
passed 166. These counts overlap on shared-client coverage and are not additive.
Shared-package type checking and both RemoteBuddy/SCM service bundles passed.
Independent review found the exclusion-restoration edge case described above;
it was corrected and its regression passed before handoff. No live model call,
job dispatch, publication, or restart was used to validate this patch.
