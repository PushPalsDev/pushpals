# v1.2.55 live observation - September 27, 2026

## Scope and evidence

The user reported no autonomous jobs after installing CLI v1.2.55 with Bun
1.3.14 on Windows x64, clearing state, and starting the runtime. This record
combines the supplied console transcript, retained service logs, and read-only
database inspection through approximately **2026-09-27T19:03Z**. It is a
retrospective diagnosis, not a claim of uninterrupted active monitoring.

The runtime invocation began at **16:49:42.467Z**. Its bootstrap log prefix is
`2026-09-27T16-49-45-181Z` under the installed runtime's `logs/bootstrap`
directory. The relevant files are `runtime-services.log`, `remotebuddy.log`,
`server.log`, and `source_control_manager.log` with that prefix. All times below
are UTC on September 27.

Investigation does not modify the external user repository, live database,
configuration, containers, or running services. Source changes are confined to
PushPals and use generic repository contracts and fixtures. They do not change
the already-running v1.2.55 installation.

## Planning and execution checkpoint

| Observation by 19:03               | Recorded result                                   |
| ---------------------------------- | ------------------------------------------------- |
| Completed RepositoryAgent analyses | 27                                                |
| First seven analyses               | Empty results; bounded evidence coverage advanced |
| Subsequent positive analyses       | 20: one fresh result followed by 19 cache hits    |
| Execution requests and jobs        | 0 and 0                                           |
| Worker capacity                    | Live, idle worker                                 |

The initial evidence-page progression introduced in v1.2.55 was working: the
first seven empty results did not repeatedly reuse the same empty page. The
eighth page produced a positive proposal for a user-facing naming repair. Its
problem statement quoted an internal orchestration term already present in the
cited repository source. Downstream admission rejected the entire proposal as
`llm_pushpals_internal_leak`.

Because the worker considered the raw nonempty result reusable, later ticks
replayed the same positive cache entry. Coverage remained on page eight with
`advanced=false`; dispatch rejected the proposal again. This is a cache/admission
mismatch, not evidence that the repository has no remaining opportunities.
Completed analysis counts and positive candidate counts must not be reported as
dispatched work, successful execution, or completed PRs.

Relevant sources:
[`apps/remotebuddy/src/repository_agent.ts`](../apps/remotebuddy/src/repository_agent.ts)
and
[`apps/remotebuddy/src/autonomous_engine.ts`](../apps/remotebuddy/src/autonomous_engine.ts).

## Health incident

Startup completed at **16:49:52.734Z**, with WorkerPal warmup continuing in the
background. The image build completed in **50.915 seconds**, and initial worker
capacity was reported ready at **16:50:43.476Z**. The earlier warming notice does
not explain the later persistent absence of jobs.

One brief shared local HTTP incident appears in the retained logs:

| UTC          | Observation                                                   |
| ------------ | ------------------------------------------------------------- |
| 18:16:19.212 | Last successful server health request before the gap          |
| 18:16:24.739 | SCM probe failed after 2,509 ms; first consecutive failure    |
| 18:16:26.767 | Server probe failed after 2,510 ms; first consecutive failure |
| 18:16:28.079 | WorkerPal reported a 6,000 ms `/jobs/claim` timeout           |
| 18:16:29.797 | SCM's second probe failed after 2,503 ms                      |
| 18:16:31.397 | Server recovered; successful probe duration 2,081 ms          |
| 18:16:32.357 | SCM recovered; successful probe duration 2 ms                 |
| 18:16:32.358 | CLI printed the aggregate healthy transition                  |

The server's health-request log gap was approximately **12.184 seconds**.
Neither service required a restart, and no native-crash, process-exit, or restart
envelope accompanies this incident. The supervisor's timeout callbacks ran near
their configured budgets; RemoteBuddy's surrounding 30-second heartbeats stayed
on schedule. These observations do not establish host sleep, a particular
event-loop blocker, CPU pressure, or a network/runtime defect. The cause remains
unknown. Do not widen timeouts or present a Bun upgrade as an evidence-backed
remedy for this event.

The v1.2.55 recovery message correctly cleared the earlier degraded console
state. Health availability and productive planning remain separate questions.
Supervisor behavior is defined in
[`scripts/start_runtime_services.ts`](../scripts/start_runtime_services.ts) and
the CLI callbacks in [`scripts/pushpals-cli.ts`](../scripts/pushpals-cli.ts).

## Cleanup reporting

The preceding `--clear` operation timed out while inspecting/removing Docker
resources with the existing **5-second warm-container** and **15-second image**
command budgets. The console nevertheless prefixed those messages with
`Nothing to clear` and ended with `Clear completed`. The timeouts establish that
cleanup was unconfirmed, not that the resources were absent. The later successful
image build and live worker also do not prove which earlier cleanup operations
completed.

The generic source fix distinguishes `removed`, `absent`, `skipped`, `timed_out`,
and `failed` outcomes. Requested Docker cleanup that is unavailable or times out
now produces an explicit incomplete `--clear` summary and **exit code 1**, after
local-state cleanup still runs. Confirmed absent/removed resources retain normal
success behavior. Startup/shutdown cleanup warns and continues; command budgets
are unchanged. See
[`scripts/pushpals-cli.ts`](../scripts/pushpals-cli.ts) and its cleanup regressions
in [`tests/cli.runtime-bootstrap.test.ts`](../tests/cli.runtime-bootstrap.test.ts).

## Implemented source changes

- Apply snapshot-stable admission to fresh results before caching and to
  validated cache hits. Unsupported objective/risk/scope/target/vision/validation
  proposals, candidates below the configured confidence floor, and genuine internal-work leakage become rejected proposals rather
  than reusable positive advice. If none remain, grounded empty-result coverage
  progression remains bounded and fenced.
- Recognize a narrowly source-verified naming repair: repository snapshot,
  target path/blob, citation coordinates, and the observed literal must agree.
  Keep the original quote/evidence in the analysis, but render the admitted
  observation safely for downstream dispatch without disabling Server/planner
  guards. There are no product-specific candidate or path exceptions.
- Use prompt/cache version `repository-agent-v8-admission-aware` so older
  admission-unaware entries do not share the new key space. Merely reading an
  autonomy cache entry does not reinforce its usefulness as successful work.
- Leave transient eligibility, including capacity, open work, cooldowns, and
  ranking scores, downstream. It is not cached structural absence, and
  these changes do not force job creation or bypass validation/publication gates.
- Report unconfirmed Docker cleanup truthfully, preserving bounded execution and
  nonblocking startup behavior.

The shared policy and source-quotation boundaries live in
[`autonomy_candidate_policy.ts`](../apps/remotebuddy/src/autonomy_candidate_policy.ts)
and
[`autonomy_candidate_admission.ts`](../apps/remotebuddy/src/autonomy_candidate_admission.ts).
The current contract is documented in
[`RepositoryAgent and shared memory`](wiki/13-repository-agent-and-memory.md).

## Validation status

Validation ran in an isolated Linux Docker container capped at **1 CPU, 768 MiB,
and 512 PIDs**, without a Docker socket or the external user repository mounted:

- Final pre-release root suite: **2,857 passed, 12 skipped, 0 failed**; 15,972 assertions
  across 192 files in 297.74 seconds. Skips require Windows or nested/host Docker
  integration; this is not a Windows soak-test result.
- RemoteBuddy TypeScript check passed.
- Full `cli:bundle` (including a fresh monitoring UI export) and the RemoteBuddy
  entry-point build passed; npm package payload verification passed for 276 files
  with no external toolchain files. The packaged RemoteBuddy fallback was
  regenerated from the corrected source.
- Composed regressions exercise real RepositoryAgent analysis, persisted SQLite
  memory, engine ticks, Server eligibility/reservation, and request confirmation.
  They cover a verified naming repair reaching dispatch and two rejected
  proposals advancing discovery before a valid proposal dispatches.
- Additional tests cover fresh/cache-hit static rejection, mixed candidate
  batches, configuration changes, incomplete/oversized manifest evidence,
  external symlink isolation, cross-ecosystem validation, and real CLI cleanup
  with deliberately unavailable Docker.
- Release smoke review found no-worker fixtures still requested Docker cleanup.
  Those fixtures now explicitly disable Docker; worker-enabled smokes retain
  their Docker requirements. Focused smoke contracts passed all 10 tests.

Two independent review passes found additional validation-boundary and cleanup
classification defects; those were corrected before the final passing suite.
The new admission and snapshot-filesystem tests are included in the reliability
harness. Earlier validation runs exposed a missing test-container UI artifact
and cleanup fixtures requiring updates for the new incomplete-cleanup contract;
the final run includes those corrections.

No observed new job or PR exists in this run from which to establish execution
latency, first-pass review quality, or live effectiveness of the working-tree
fixes. Changes remain local and unreleased at this checkpoint. A subsequent
deployed run is still required to establish live execution and publication
outcomes; the isolated regressions are not a claim of 100% uptime or job success.
