# v1.2.54 live observation — September 25, 2026

## Scope and duration

- User requested at least three hours of observation and evidence-backed fixes.
- Observation began at **2026-09-25T21:21:13Z**; the minimum end is
  **2026-09-26T00:21:13Z** (5:21 PM Pacific on September 25).
- Active interactive checks were recorded through **2026-09-25T22:54:27Z**
  (about 93 minutes). The next user message resumed inspection at
  **2026-09-27T01:26:34Z**. The intervening period below is reconstructed from
  retained logs and read-only database records, not uninterrupted active
  monitoring. Do not describe this as a completed continuous three-hour soak.
- Live CLI: v1.2.54, Bun 1.3.14, Windows x64. Invocation: 21:20:28Z.
- Observe logs, read-only SQLite snapshots, and bounded health endpoints. Do not
  change SectorCommand, its database/configuration, or its running processes.
- Implement generic changes in PushPals only. Run tests in the owned isolated
  container, limited to one CPU, 768 MiB, and 512 PIDs, with no live-repo mount or
  Docker socket. Source fixes do not alter this running installation.
- The initial observation request did not authorize an additional release or
  installation. The subsequent September 27 request authorizes completing the
  fixes, committing, pushing, and releasing. It does not request replacement of
  the live SectorCommand installation.

## Baseline

- Embedded runtime readiness: **8.659 seconds**, versus 13.523 seconds in the
  preceding v1.2.53 observation. This is one pair of cold starts, not a benchmark.
- Initial server connection refusal was reported as `starting`, followed by
  healthy/ready confirmation. No misleading restart recommendation appeared.
- SCM launch immediately followed RemoteBuddy launch, with `workerpal=0ms(deferred)`.
- Worker image build: **47.511 seconds**. Worker `workerpal-muhgt32t12q4` registered
  at 21:21:27Z, approximately 59.5 seconds after invocation.
- At 21:21:48Z, server and SCM health were good, publication backlog was zero,
  and SCM reported `pendingFeedbackCount=7`, `failureEvents=0`, and no degraded
  components. These are old merged PRs whose persisted job authority was removed
  by the user's preceding clear operation; they are not new failed jobs.
- Existing PR #395 was skipped for a 412,233-byte diff, and #593 for an empty diff.
  Neither is counted as a successful new job or modified by this observation.

## Tracking

Track service crashes/restarts, worker availability, planning cycles and evidence,
durable requests/jobs, execution and finalization duration, publication failures,
PR revisions versus first-pass merge, repeated failure fingerprints, and vision
alignment. Keep unknown or missing outcomes separate from successful execution.

## Timeline

| UTC   | Observation                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 21:21 | Healthy cold startup; worker available; old feedback pending without provider degradation.                                                                                                                                                                         |
| 21:23 | First Repository Agent request completed in 34.881s (engine phase 38.775s), cache miss, five evidence references, no candidates. Citations reached source lines beyond 1,200, confirming the new evidence-window behavior is live.                                 |
| 21:27 | One idle worker, no requests/jobs; fresh SCM ticks, zero backlog and provider failures.                                                                                                                                                                            |
| 21:32 | Third completed analysis: zero candidates, second consecutive exact-cache hit. No requests or jobs have been dispatched.                                                                                                                                           |
| 21:36 | Server/SCM remain healthy; old pending feedback has settled from seven to zero without provider failures. New analysis metrics pass 35 tests, including a real SQLite planning-to-publication lifecycle fixture.                                                   |
| 21:45 | Five analyses completed, four exact-cache hits, all with zero candidates. No durable requests/jobs. Full test command, RemoteBuddy type-check, CLI build, and package-payload verification passed in the capped container; reliability harness underway.           |
| 21:49 | Six empty analyses, five cache hits, still zero requests/jobs. Healthy server and fresh SCM ticks; zero publication backlog, pending feedback, and provider failures. Full suite: 2,701 passed, 12 skipped, zero failed; protocol checks: 51 passed.               |
| 21:51 | All seven reliability-harness phases passed (322.665s). The owned validation container is stopped after testing; live monitoring continues.                                                                                                                        |
| 22:06 | Nine analyses completed, eight cache hits, all empty; zero requests/jobs. Fresh health/tick samples remain good. One model usage event is recorded, explicitly estimated at 28,879 tokens, rather than one new provider call per planning cycle.                   |
| 22:21 | One-hour checkpoint: 12 completed analyses, 11 cache hits, all empty; zero requests/jobs. Usage remains one estimated 28,879-token event. Server, SCM, and autonomy heartbeats are fresh; zero backlog/provider failures and no observed crash/recovery envelopes. |
| 22:35 | Fifteen analyses completed, fourteen cache hits, all empty. Health checks remain good and publication/feedback queues remain empty. No new failure class observed.                                                                                                 |
| 22:51 | Ninety-minute checkpoint: 18 completed analyses, 17 cache hits, all empty; zero requests/jobs. Fresh autonomy heartbeats and healthy server/SCM samples. No observed crashes, recoveries, or publication backlog.                                                  |

## Findings and validation

The first observation segment and later retrospective inspection are distinct.
Do not infer continuous availability or successful job throughput from either
healthy samples or completed planning analyses alone.

Code investigation following the empty first cycle identified:

- Structured `vision.non_goals` is sent by autonomy but omitted from the compact
  model context. Bounded file excerpts cannot substitute for retaining explicit
  exclusions.
- Structural synthesis receives transient eligibility signals absent from its
  cache key, so a temporary reason to omit a candidate can become a cached
  structural answer.
- Successful empty candidate lists are cached for the normal 24-hour TTL before
  retrieval runs, and uncached discovery repeatedly chooses the same top paths.
  Limited evidence is not proof that all repository opportunities are exhausted.
- The read-only run-health report lacks analysis/candidate-empty telemetry when
  no worker jobs have been created.

Implemented generic source fixes:

- Preserve bounded vision exclusions and use the same normalized structural
  context for retrieval, synthesis, and cache identity. Apply transient
  eligibility downstream instead of caching it as repository structure.
- Persist bounded evidence-page progress after grounded empty results, with
  separate page caches, compare-and-set ownership, deadline fences, and final
  snapshot verification. Keep positive cache reuse and all existing safety gates.
- Report repository-analysis latency/cache counts and empty/nonempty/unknown
  candidate outcomes separately from requests, jobs, publication, and merge.
- Refresh the packaged RemoteBuddy runtime and document the behavior and limits.

Validation completed in the capped Linux container:

- RemoteBuddy TypeScript check: passed.
- Targeted tests: 177 passed, zero failed.
- Full root suite: 2,701 passed, 12 skipped, zero failed (273.25s).
- Prompt-policy tests: two passed; protocol checks: 51 passed.
- Reliability harness: all seven phases passed (322.665s).
- CLI build and package-payload verification: passed (276 packaged files).
- New regression coverage includes SQLite restart, concurrent cursor writes,
  expiry/invalid rows, cancellation, snapshot races, Unicode normalization,
  unsafe paths, metric ambiguity, and a real SQLite planning-to-merge lifecycle.

These source fixes do not change the running v1.2.54 installation. Tests use
generic repositories and controlled providers; they do not establish live job
throughput, first-pass PR quality, or universal uptime. Optional platform/Docker
integrations are skipped in this no-Docker-socket Linux fixture; it is not a new
Windows-host integration run. Exploration is capped at 96 additional paths plus
seed anchors, not a full repository audit, and does not force job creation.

No release or installation had been performed at this observation checkpoint.

## Retrospective checkpoint: September 27, 01:27 UTC

The user's follow-up attachment repeats the same v1.2.54 invocation and adds
health warnings from September 27 at 01:01 UTC. It is not a run of the local
source fixes described above.

- The original three-hour window contains **36 completed analyses, 35 cache
  hits, and zero dispatched requests/jobs** in the retained database.
- At 01:27:57 UTC the complete run contains **338 completed analyses, 336 cache
  hits, zero candidates, and zero requests/jobs**, after roughly 28 hours.
- Only two provider calls are recorded, with **57,922 estimated tokens**. The
  second call occurred after the 24-hour cache expired and again returned an
  empty result from limited evidence. Cache expiry alone did not restore useful
  exploration. The worker is idle with a fresh heartbeat.
- Server and SCM health currently pass. SCM's publication and feedback backlogs
  are zero. Its one historical provider-failure event is not an active failure:
  consecutive failed polls are zero and the latest provider poll succeeded.

### New diagnostic findings (diagnosis checkpoint)

1. **Recovery is invisible in the terminal.** SCM's first failed health probe
   was recorded at 01:01:05.262 and Server's at 01:01:06.273. Both returned healthy
   at 01:01:10.192 and 01:01:10.200 respectively, without a crash or restart.
   The CLI writes these recovery events only to disk; clearing the final degraded
   aggregate formats `null` as no console output. Thus the last visible terminal
   message incorrectly appears unresolved. Emit a transition-specific recovery
   message and distinguish retryable transport warnings from crash/restart advice.
   Relevant source: `scripts/pushpals-cli.ts` health lifecycle/aggregate callbacks
   and `scripts/start_runtime_services.ts` health formatter/recovery handling.
2. **Missing branch cleanup is not idempotent for GitHub's actual response.**
   Seven old merged PR branches returned HTTP 422 with `Reference does not exist`.
   `deleteBranchRef` in `apps/source_control_manager/src/github_pr.ts` only treats
   404 as already absent. These warnings did not undo reconciliation, reopen jobs,
   or block publication. Recognize only this precise missing-reference 422 and
   retain errors for other 422 responses and authorization/provider failures.
3. **Transient transport failures recovered.** GitHub DNS failures at September
   26 20:13 and 21:36 were followed by successful integration maintenance roughly
   32 seconds later. One PR-list transport failure occurred at 23:10. The local
   incident at 01:01 also timed out one WorkerPal claim request and briefly paused
   AI review; both subsequently resumed. Logs do not establish whether the shared
   local delay was CPU pressure, event-loop delay, networking, or another cause.
   There is no evidence here of a native Bun crash. Do not weaken timeouts or
   recommend a runtime upgrade as a proven remedy for this event.

At this diagnosis checkpoint, the planning/metrics patch was tested but **not
installed in this run**, and the additional console/cleanup defects were reviewed
but not yet implemented.
There are no new completed jobs or PRs from which to judge execution latency or
first-pass review quality.

## Authorized release follow-up

The subsequent request authorizes all observation-backed fixes plus commit,
push, and release. The planning/metrics changes remain generic; no production
logic encodes SectorCommand paths or priorities. An independent final review
found no blocking defect in their cache/coverage, snapshot, memory, or metric
contracts.

The follow-up adds transition-specific CLI recovery reporting, actionable
transient-failure guidance, and precise missing-reference branch-cleanup
classification. Regression coverage includes partial/full service recovery,
genuine provider errors, and merged/closed PR reconciliation through the real
branch-response classifier. Health recovery checks also gate Linux/Windows CLI
CI and Windows release validation. Final validation and release metadata are
recorded in `release_log.md`.
