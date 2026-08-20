# 07. WorkerPals (`apps/workerpals`)

## Purpose

WorkerPals is the execution engine. It takes planned jobs and turns them into concrete repository changes.

Main responsibilities:

- claim jobs from Server,
- run backend agents (`miniswe`, `openhands`, `openai_codex`),
- stream logs back to Server,
- create job-scoped commits,
- enqueue completion records for integration.

## Component Contract

- Receives: a fenced `task.execute` claim and its planning/validation contract.
- Owns: isolated worktree preparation, backend execution, validation, logs, and candidate commits.
- Produces: diagnostics plus a terminal job result or an immutable completion handoff.
- Does not own: queue truth, runtime-circuit admission, or publication policy.

## Key Files

- `apps/workerpals/src/workerpals_main.ts` - daemon loop, claim/report lifecycle.
- `apps/workerpals/src/execute_job.ts` - task execution orchestration and quality gates.
- `apps/workerpals/src/docker_executor.ts` - warm-container runtime and worktree isolation.
- `apps/workerpals/src/job_runner.ts` - container-side execution wrapper.
- `apps/workerpals/src/common/server_transport.ts` - bounded heartbeat and control-plane delivery.
- `apps/workerpals/src/common/direct_worktree.ts` - host worktree preparation and cleanup boundary.
- `apps/workerpals/src/timeout_policy.ts` - shared execution deadline policy.
- `apps/workerpals/src/backends/backend_config.ts` - backend registry/config mapping.
- `apps/workerpals/src/backends/*` - backend-specific integrations.

## Execution Modes

- Host mode:
  - jobs run directly in host worktrees.
- Docker mode (recommended/default in full stack):
  - jobs run in isolated containers with worktree mounting.
  - warm container model reduces repeated startup overhead.

## Job Lifecycle

At a high level:

1. Worker claims or replays a job with exact worker/generation authority.
2. Circuit-blocked work is deferred; admitted work receives a positive `/start` acknowledgement.
3. Isolated worktree is created and the backend executor runs the task.
4. Logs stream to Server as fenced job logs.
5. Job result, token usage, cooldowns, validation runs, and patch snapshots cross
   the Docker boundary as one structured result.
6. If a candidate commit exists, WorkerPals enqueues its immutable completion handoff and the job becomes `finalizing`.
7. Otherwise it persists the exact `complete`, `fail`, or `publish-blocked` terminal result.
8. Worktree is cleaned up.

Logs, diagnostics, deferrals, terminal reports, and completion handoffs carry `workerId + claimGeneration`. Authoritative control transitions are confirmed only by an explicit JSON `{ "ok": true }`. After an ambiguous response, WorkerPals retries the identical transition a bounded number of times; if it remains unconfirmed, it suppresses contradictory projection and recycles so Server recovery stays authoritative. Server admission permits only its single half-open runtime canary to cross the execution boundary.

The daemon sends its packaged runtime generation on claims and heartbeats. The
Server rejects a WorkerPal from a different generation, preventing a stale
process from serving a newly started packaged runtime. Log delivery also sends
the job's claim generation so delayed output remains attributable to the claim
that produced it.

Unhandled JavaScript failures at the WorkerPal-owned stack boundary are
reported with structured `worker_runtime_failure` diagnostics owned by
`workerpals_main`. Expected Docker retry exhaustion remains a Docker-boundary
failure rather than being mislabeled as a WorkerPal implementation crash.

## Why Worktree Isolation Matters

Each job runs in an isolated git worktree to avoid cross-job contamination.

For Linux-container jobs, dependency snapshots and per-job hardlink projections
live in a repo-keyed Docker volume. The Windows bind-mounted worktree receives
only a symlink to that container-native projection, so dependency preparation
does not recursively copy `node_modules` through the host filesystem. Progress
is streamed as `DependencyPreparation` phase telemetry and is bounded by
`workerpals.dependency_preparation_timeout_ms` (five minutes by default).
The preparation and validation paths share one fingerprint version keyed by
Bun, dependency manifests, platform, and workspace identity, preventing a valid
Linux projection from being discarded and reinstalled during quality checks.

OpenAI Codex workers also keep Linux-specific state in a per-worker named
volume. Only the host `auth.json` is mounted read-only and copied when its hash
changes; Windows caches, sessions, and executable state are never projected
into the Linux container. Runtime upgrades clear version-specific state while
preserving refreshed credentials.

This provides:

- safer parallelism,
- clear commit provenance by job,
- simpler cleanup semantics.

## Quality and Guardrails

`execute_job.ts` adds quality mechanisms beyond "run command":

- deterministic quality checks for test-focused tasks,
- validation-step execution support,
- optional critic/revision loops (backend-specific),
- output compaction and structured result handling.

Packaged WorkerPal sandbox images receive the complete runtime prompt bundle,
including the shared ReviewAgent rubric used by CriticGate. Package-payload and
runtime-completeness checks require the critical critic/reviewer files. If an
already-running image is damaged or incomplete, CriticGate uses a conservative
built-in rubric and reports the degraded asset instead of terminating every
job without a structured result.

An environment-blocked required validation gate is not treated as a code
revision request by itself. Scope checks and the critic still run first, using
the same rubric and pass threshold as the final ReviewAgent. Only a candidate
that clears those gates is retained under its internal ref and handed to
SourceControlManager with the exact blocked commands.
SourceControlManager applies the candidate to its temporary publication branch,
runs those commands on the trusted host without a shell, and only continues to
merge or PR publication after they pass. A failed trusted check retains the
internal ref for diagnosis; a failed queue handoff is reported as
`publish_blocked` instead of silently deleting the candidate.

## Operational Failure Patterns

- Backend output parse errors:
  - usually schema/format mismatch in executor output.
- `missing_runtime_asset`:
  - the packaged sandbox is incomplete or stale; rebuild it from a runtime
    bundle that passed the package-payload checks.
- Docker warm container issues:
  - usually image/tooling/network precondition failures.
- Dependency preparation timeout:
  - inspect the last `DependencyPreparation` phase/progress event; cold snapshot
    installs, cache hits, and projection are reported separately.
- Repeated timeouts:
  - usually budget mismatch or backend model/tool slowness.

## Backend Abstraction

`backend_config.ts` plus backend specs provide:

- named backend selection from config,
- runtime python/timeout mapping,
- docker warmup hooks,
- task executor registration.

This keeps `workerpals_main.ts` mostly backend-agnostic.

## Tradeoffs

Pros:

- strong isolation for safety and reproducibility,
- backend modularity,
- resilient execution with retries/backoff.

Cons:

- Docker mode adds startup and tooling requirements,
- backend diversity increases complexity and test matrix size,
- execution wrappers are operationally heavy.

## Debugging Checklist

1. Confirm worker heartbeat recency.
2. Confirm claimed job state transitions and job logs.
3. Confirm executor backend and timeout config in effective runtime config.
4. Confirm Docker image and warm-container health when in Docker mode.

## Future Improvements

- Add per-backend capability declarations and planner-aware backend routing.
- Add richer artifact publishing (diff summaries, file-level metrics, coverage deltas).
- Add adaptive timeout policies based on historical task profiles.
