# 07. WorkerPals (`apps/workerpals`)

## Purpose

WorkerPals is the execution engine. It takes planned jobs and turns them into concrete repository changes.

Main responsibilities:

- claim jobs from Server,
- run backend agents (`miniswe`, `openhands`, `openai_codex`),
- stream logs back to Server,
- create job-scoped commits,
- enqueue completion records for integration.

## Key Files

- `apps/workerpals/src/workerpals_main.ts` - daemon loop, claim/report lifecycle.
- `apps/workerpals/src/execute_job.ts` - task execution orchestration and quality gates.
- `apps/workerpals/src/docker_executor.ts` - warm-container runtime and worktree isolation.
- `apps/workerpals/src/job_runner.ts` - container-side execution wrapper.
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

1. Worker claims job.
2. Isolated worktree is created.
3. Backend executor runs task.
4. Logs stream to server as job logs.
5. Job result is reported complete/fail.
6. Commit metadata is enqueued as completion when applicable.
7. Worktree is cleaned up.

## Why Worktree Isolation Matters

Each job runs in an isolated git worktree to avoid cross-job contamination.

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

## Operational Failure Patterns

- Backend output parse errors:
  - usually schema/format mismatch in executor output.
- Docker warm container issues:
  - usually image/tooling/network precondition failures.
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
