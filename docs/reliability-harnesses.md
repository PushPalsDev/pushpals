# PushPals Reliability Harnesses

PushPals treats worker completion, publication, and trusted-host validation as one end-to-end attempt. A job is not successful merely because a worker process exited cleanly.

## Consolidated harness

Run the reliability contract locally with:

```powershell
bun run harness:reliability
```

The harness emits one JSON envelope for each phase and a final summary. Each phase has a bounded runtime and stops the harness on its first failure.

| Phase                  | Contract                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failure_evidence`     | Failure paths, test names, diagnostics, fingerprints, transient retry metadata, and no-change session outcomes remain candidate-specific and truthful.                                                                                                                                                                                                                      |
| `durable_lifecycle`    | Worker-required requests cannot complete without a durable job across queue and HTTP boundaries; claimed requests renew completion leases; expired handoffs reconcile after restart; WorkerPal runtime circuits persist per packaged generation, admit one half-open canary, and recover bounded deferrals and lost leases.                                                 |
| `repair_orchestration` | A validation incident has one active exact-candidate repair; repaired candidates preserve publication state; processed publication refs are reclaimed only from an exact, durable authority record; SCM Git, review, and check subprocesses have hard deadlines and bounded pipes; an open target circuit moves autonomy to another component instead of stopping the tick. |
| `runtime_boundary`     | Process trees, complete HTTP responses, SSE/no-newline streams, and Docker control calls are bounded across the CLI, browser client, VS Code client, and runtime services; LF worktree contracts remain valid; Linux containers perform dependency-store I/O and the production backend readiness probe.                                                                    |

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

## Outcome and evidence metrics

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

### Metrics

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
