# PushPals Reliability Harnesses

PushPals treats worker completion, publication, and trusted-host validation as one end-to-end attempt. A job is not successful merely because a worker process exited cleanly.

## Consolidated harness

Run the reliability contract locally with:

```powershell
bun run harness:reliability
```

The watchdog phase requires Python 3. On Linux images without a `python` alias,
run `PYTHON=python3 bun run harness:reliability`; the harness honors `PYTHON` as
the executable override.

The harness emits one JSON envelope for each phase and a final summary. Each phase has a bounded runtime and stops the harness on its first failure.

Repository evidence regressions cover fair UTF-8 byte allocation across selected
files, bounded original-line windows beyond large file headers, and rejection of
citations into omitted or partially supplied lines. These checks preserve one
synthesis stage, repository containment, snapshot identity, and empty-candidate
results when the supplied evidence still does not justify implementation work.

| Phase                     | Contract                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository_intelligence` | Repository analysis and memory preserve snapshot/claim authority; vision exclusions and empty candidate results cannot manufacture work.                                                                                                                                                                                                                                    |
| `failure_evidence`        | Failure paths, test names, diagnostics, fingerprints, transient retry metadata, and no-change session outcomes remain candidate-specific and truthful.                                                                                                                                                                                                                      |
| `durable_lifecycle`       | Worker-required requests cannot complete without a durable job across queue and HTTP boundaries; claimed requests renew completion leases; expired handoffs reconcile after restart; WorkerPal runtime circuits persist per packaged generation, admit one half-open canary, and recover bounded deferrals and lost leases.                                                 |
| `repair_orchestration`    | A validation incident has one active exact-candidate repair; repaired candidates preserve publication state; processed publication refs are reclaimed only from an exact, durable authority record; SCM Git, review, and check subprocesses have hard deadlines and bounded pipes; an open target circuit moves autonomy to another component instead of stopping the tick. |
| `quality_loop`            | Focused validation, critic decisions, retained timeout candidates, and repeated capability blockers preserve actual evidence without bypassing quality gates.                                                                                                                                                                                                               |
| `worker_watchdog`         | Backend watchdog/runtime policy bounds executor progress and preserves meaningful recovery evidence.                                                                                                                                                                                                                                                                        |
| `runtime_boundary`        | Process trees, complete HTTP responses, SSE/no-newline streams, and Docker control calls are bounded across the CLI, browser client, VS Code client, and runtime services; LF worktree contracts remain valid; Linux containers perform dependency-store I/O and the production backend readiness probe.                                                                    |

The release workflow builds the WorkerPal sandbox image on Ubuntu and runs this harness with both Linux container dependency-projection integrations enabled. A release cannot publish when those gates fail. The opt-in flags for an equivalent Linux run are:

```powershell
$env:PUSHPALS_RUN_DEPENDENCY_PROJECTION_INTEGRATION = "1"
$env:PUSHPALS_RUN_CONTAINER_VOLUME_INTEGRATION = "1"
bun run harness:reliability
```

That Ubuntu gate does not claim to reproduce a Windows bind mount. The actual Windows-host/Linux-container LF and hardlink boundary remains a separate opt-in test and runs in the `Windows Host Docker E2E` workflow on a Windows runner with Linux Docker support:

```powershell
$env:PUSHPALS_WINDOWS_LINUX_WORKTREE_E2E = "1"
$env:PUSHPALS_WORKTREE_BOUNDARY_IMAGE = "pushpals-worktree-boundary:test"
bun test tests/workerpals.worktree-boundary.test.ts
```

SourceControlManager local Git commands default to a two-minute deadline and
network operations (`fetch`, `push`, and related commands) default to five
minutes. Override those bounds only for unusually slow repositories:

```powershell
$env:PUSHPALS_SCM_GIT_COMMAND_TIMEOUT_MS = "120000"
$env:PUSHPALS_SCM_GIT_NETWORK_TIMEOUT_MS = "300000"
```

Executable discovery is independently bounded by
`PUSHPALS_SCM_GIT_DISCOVERY_TIMEOUT_MS` (10 seconds by default). On Windows, a
deadline terminates the full process tree with `taskkill /T /F`; stdout and
stderr are captured concurrently with a size cap and bounded drain so a leaked
credential-helper pipe cannot stall publication.

Control-plane and model HTTP deadlines cover both response headers and body
consumption. A peer that sends headers and then leaves its body open therefore
cannot block LocalBuddy, RemoteBuddy, WorkerPal, or SourceControlManager pollers.
The reliability harness exercises both the never-headers and never-body cases.

WorkerPal startup uses coordinated, bounded preflight, image-build, fallback-pull,
and self-check phases. The supervisor passes its absolute deadline to the worker;
child commands consume the remaining phase/startup budget rather than resetting
it on retries. Build execution allows up to ten minutes, a startup pull up to ten
minutes, and the complete Docker self-check up to five minutes. The supervisor
allows 30 seconds for bounded timeout cleanup and delivery of the terminal phase
marker. All phases and registration share one hard ceiling: the normal startup
timeout plus 25.5 minutes (27.5 minutes with the default two-minute timeout).
This is a maximum for cold/recovery startup, not a mandatory wait or a job budget.

Quiet package-install steps are allowed within the fixed build budget. Progress
reports observed byte counts, not raw build output, and cannot extend deadlines.
Only the server's online worker state establishes readiness. Failed startup must
clean up its Docker resources before exit or direct-mode fallback. The supervisor
also reconciles containers belonging to the exact repository and worker ID after
process exit/termination; unverified cleanup fences replacement rather than
silently accumulating containers. Other repositories' containers are untouched.

Runtime-boundary regressions cover actual timeout-to-fallback transitions, slow
self-checks, cleanup failure/retry, disposal during prewarm, malformed progress,
output backpressure, and shared warmup between autoscaling and request admission.

Initial service connection refusals are reported as bounded startup rather than
immediately recommending a restart. Explicit unhealthy responses, crashes,
post-readiness failures, and elapsed startup grace still surface as degradation;
probe counters and restart deadlines remain authoritative.

CLI worker capacity is checked once after embedded service startup. Background
warmup does not hold up SourceControlManager launch, and a cold worker does not
prevent the CLI from connecting. The capacity probe shares one finite deadline
across status requests, transient-error retries, and sleeps. Manual workers are
queried even with auto-spawn disabled. A failed or malformed worker-status
response is reported as unconfirmed/blocked execution, never as a valid empty
worker list or successful readiness. `/status` refreshes the startup snapshot.
The `cli.worker-startup-readiness` regressions gate these cases, including local
HTTP failure responses and the single-probe startup wiring.

## Outcome and evidence metrics

For a bounded, read-only report against any repository's PushPals database:

```powershell
bun run scripts/run-health-report.ts --db "C:\path\to\repo\outputs\data\pushpals.db" --since "2026-09-11T09:32:32Z" --until "2026-09-11T21:00:00Z"
```

The window selects job creation times; outcomes reflect current persisted state,
not a reconstructed historical snapshot. JSON separates terminal success,
verified publication, provider merges, recorded first-pass reviews, end-to-end
duration, execution-to-handoff, publication waiting, and trusted validation.
Request-status counts use a separate creation-time cohort, making failures before
job creation visible. Request completion does not establish job or PR success;
missing request history remains unknown and row-cap sampling is explicit.
Absent latency or review evidence remains unknown; publication never implies
approval, and the report cannot infer uptime without continuous health samples.
Reads use a consistent, read-only SQLite transaction with per-table caps and
explicit missing/truncated-evidence markers. No queue initialization, migration,
repair, or live-service startup is performed.

The harness includes parser and tick fixtures for nested vision exclusions,
wrapped priorities, and explicit no-suitable-work results. Failure-circuit tests
separate deferred checks from executed failures, preserve failures across later
deferrals, and reject incidental shared-file collisions. Real SQLite and Git
fixtures protect browser capability holds, checkpoints, claim fencing, and
unrelated-job progress. Runtime tests cover silent pooled sockets, fresh health
connections, bounded oversized-body rejection, sustained transport outages,
and health-confirmed recovery rather than spawn-only success.

Oversized control requests discard remaining upload bytes within a short time
and byte budget before returning `413`; they never become accepted requests.
Tests cover normal pooled requests after rejection, byte-cap exhaustion, and
stalled uploads. Bun 1.3.14 can retain a sender's socket despite a close header,
so an unfinished/rejected sender must abandon that connection. Independent fresh
health connections remain usable; this is not a claim that native socket cleanup
has been fixed for every malformed client.

Terminal no-change classification reads structured outcome fields, not embedded
stdout, artifacts, or historical revision text. A published job cannot become
no-change merely because an earlier revision produced no diff; explicit terminal
no-change outcomes still never count as successful delivery. Pending and running
rows remain nonterminal even if their context mentions a no-change outcome.
Likewise, historical or negated clarification text cannot label a delivered patch
as a request for clarification; actual current clarification outcomes remain
unsuccessful, including the existing OpenHands declaration contract.

EventStore installs a startup-only SQLite busy handler before WAL and schema
initialization (at most one second per statement, not a total migration budget).
It then restores the previous zero-wait runtime behavior. A failed constructor
closes its connection. Real child-process lock tests cover transient recovery,
persistent-lock failure, preserved data, and the restored runtime wait policy.

### Result delivery and circuit recovery

Worker completion control frames are retained separately from the ordinary log
tail. Large validation output cannot remove the completion sentinel or evict a
candidate's commit, trusted-validation handoff, or usage metadata. Output fields
retain at most 32,768 characters of head/tail text each; frames have a separate 2,097,152-character
limit and fail explicitly on overflow. The newest malformed frame never falls
back to an earlier success. The runtime-boundary harness covers adversarial
chunks, shutdown noise, Unicode, overflow, and immediate process exit.

An open WorkerPal runtime circuit still requires a successful canary to close.
After cooldown, an empty queue can admit one durable request to supply that
canary; concurrent admissions and unconfirmed requests cannot multiply probes.
Existing queued work takes precedence. Normal request leases and the atomic
worker-canary claim retain ownership through planning, execution, and recovery.
The HTTP harness exercises empty-queue recovery, concurrent admission, idempotent
replay, successful probes, and repeated failures.

RemoteBuddy checks `autonomyAdmission` on `/workers/autoscale` before repository
ideation or scoring. Rejected handoffs record HTTP status and a bounded reason
code in `autonomyEnqueueRejected`, objective `block_reason`, and tick status.
Transport, malformed-response, and confirmation failures also back off; unknown
admission codes do not bypass backoff. Backoff intervals are capped at 30 minutes, and
target-specific suppression continues to allow other components.

Trusted-host validation emits `trustedValidationProgress` at each start,
completion, and retry boundary with job/completion/candidate identity and
credential-redacted commands. An explicit timeout-only test-runner failure gets
one retry, without discarding named-test evidence. Assertions and mixed failures
do not qualify for that timeout retry; repeated failure still blocks publication.

### Bounded recovery and learning

Focused JavaScript validation must respect repository test-runner ownership.
The shared runner-routing fixtures cover mixed Bun/Vitest/Jest repositories,
nearest package boundaries, configured suites, name filters, and ambiguous or
excluded targets. A script that can pass without discovering the requested file
is not acceptable evidence of ownership. Routing does not remove mandatory gates.

SCM persists exact-revision review decisions before provider or repair side
effects. Restart and transient admission retries reuse that decision instead of
asking the model to rescore unchanged code. Real temporary-SQLite tests cover
close/reopen, changed revisions, active repairs through finalization, and exhausted
repair admission. Windows CI and release checks also exercise HTTP health while a
bounded validation child emits output, times out, and has its process tree drained.

The repair harness and Windows CI/release gates also exercise review publication
against a target branch that was already newer at dispatch or moved during
validation. Retained-candidate Git fixtures protect original PR changes, exact
head leases, fresh validation proofs, and restart recovery. SQLite lifecycle
regressions verify that completion-claim recovery does not create another coding
job or consume code-quality repair attempts. Passing host checks followed by a
publication failure must retain their passing evidence and correct terminal phase.

Failure-evidence tests include noisy expected application errors, repeated Bun
summaries, duplicate test names across files, and truncation next to oversized
logs. The completion-to-autonomy harness verifies that actual failed-test names
and paths survive the durable handoff and remain at the front of repair context.
Passing negative-path test names must not create false failures; a real wrapper
failure must still veto a nominally successful child exit.

Short executor revisions reserve time for independent validation and critic
review inside the original job deadline. A backend's explicit retained timeout
candidate can enter those gates; it cannot bypass them or start another editing
loop. A passing critic with unresolved must-fix findings is insufficient for
timeout recovery. Docker-dependent checks remain held for trusted-host validation,
while runnable failures drive focused repair. Earlier validation, patch, and
critic evidence survives a later executor failure.

The `quality_loop` phase includes real temporary-Git-repository recovery tests
with focused Bun tests and a controlled critic subprocess. They exercise accepted
recovery, rejected recovery, deadline exhaustion, and evidence preservation.

RepositoryAgent uses the same candidate enums and schema as autonomy admission.
It may correct a malformed candidate once within the existing synthesis deadline;
invalid results cannot become reinforced cache hits. Analysis-cache reads are not
successful-job observations. Executed outcomes are selected before limiting the
context size, and a compact retained-outcome watermark prevents an older analysis
from reappearing when the detailed 24-hour narrative expires.

A terminal trusted-host failure with named tests, paths, and exact candidate or
baseline authority can admit one incident-scoped repair without waiting for a
second failed job. Concurrent ticks still share one repair lease. Worker uploads
cannot label their own validation as trusted-host evidence or replace SCM's
persisted results. The separate cross-job circuit threshold is unchanged.

### Metrics

Worker phase intervals inferred from logs use `transitioned` when a later phase
was observed. This describes an interval boundary, not a successful test result;
the separate validation-run records remain authoritative for pass/fail. Only
the last open interval receives the terminal job outcome. Each interval also
records `metadata.jobOutcome`. Long revision loops retain the first and last
31 intervals, including the terminal phase, and disclose `omittedSpanCount` on
the first interval instead of silently dropping the failure location.

The autonomy operations summary and System pane report:

- attempt outcomes: `succeeded`, `quality_rejected`, `validation_blocked`, `environment_blocked`, `no_change`, and `infrastructure_failed`;
- end-to-end attempt and terminal-objective success rates;
- non-terminal PR revision events, revised-objective counts, revision rate, and first-pass rate;
- average, p50, and p95 attempt duration;
- trusted-validation evidence coverage and fingerprint collisions;
- transient validation retries;
- active validation incidents;
- worker handoff failures and stalled handoffs.

Use attempt outcomes to decide whether code repair is appropriate. Environment and infrastructure failures must be repaired at their boundary; deterministic candidate failures can dispatch one incident-scoped repair. A changed candidate, baseline, command, or failure diagnostic creates new evidence and reopens evaluation.
