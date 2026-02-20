# 06. RemoteBuddy (`apps/remotebuddy`)

## Purpose

RemoteBuddy is the planning and orchestration brain.

It is responsible for:

- claiming queued requests,
- generating structured plans,
- deciding lane (`deterministic` vs `worker`),
- emitting user-facing assistant updates,
- enqueuing executable jobs for WorkerPals,
- optionally running autonomous objective cycles.

## Key Files

- `apps/remotebuddy/src/remotebuddy_main.ts` - orchestrator loop and request lifecycle.
- `apps/remotebuddy/src/brain.ts` - strict planner and fallback repair logic.
- `apps/remotebuddy/src/path_targeting.ts` - path hint extraction and normalization.
- `apps/remotebuddy/src/idempotency.ts` - replay-safe duplicate suppression.
- `apps/remotebuddy/src/autonomous_engine.ts` - autonomy ideation/scoring/planning dispatch loop.
- `apps/remotebuddy/src/llm.ts` - provider abstraction (LM Studio, OpenAI, Ollama, Codex CLI).

## Planner Contract

The planner targets strict structured output:

- intent,
- worker requirement,
- lane selection,
- read/write scope,
- discovery hints,
- acceptance criteria,
- validation steps,
- risk level,
- user/assistant/worker messages.

RemoteBuddy includes repair and fallback behavior for malformed model output, then applies safety sanitization.

## Request Lifecycle In RemoteBuddy

For each claimed request, RemoteBuddy typically:

1. Reads request metadata and routing hints.
2. Generates structured plan output.
3. Normalizes/sanitizes plan (intent, lane, scope, messages).
4. Emits user-facing assistant status/messages.
5. Enqueues worker job when `requires_worker=true`.
6. Marks request complete/fail with traceable metadata.

## Scope and Path Safety

`path_targeting.ts` and shared policy utils normalize:

- repo-relative path hints,
- write globs,
- explicit target paths from user prompts.

RemoteBuddy also patches planner output when needed so write globs cover target paths.

## Autonomy Engine

Autonomy is implemented as a bounded control loop:

1. Preflight repository health checks.
2. Acquire dispatch lock.
3. Build snapshot from Server autonomy store.
4. Run ideation phase (candidate generation).
5. Run scoring phase.
6. Run planning phase for selected candidates.
7. Enqueue synthetic background requests with scoped metadata.
8. Persist telemetry, release lock, and wait for next tick.

Policy/budget/cooldown constraints are first-class.

## Autonomy Safety Gates

Autonomy dispatch is blocked when any of the following fail:

- lock acquisition/renewal,
- snapshot freshness and repo preflight checks,
- policy checks (risk/breadth/objective constraints),
- confidence and dispatch budget constraints,
- scope invariants for target paths and write globs.

## Tradeoffs

Pros:

- clear separation of planning from execution,
- strong structure around LLM outputs,
- autonomy built with policy and budget gates, not open-ended loops.

Cons:

- planning object is rich and can be intimidating to modify,
- orchestration code path is long,
- autonomous mode introduces additional state/locking complexity.

## Debugging Checklist

- "Request never dispatched to worker":
  - inspect `requires_worker`, lane, and scope normalization output.
- "Autonomy loop runs but dispatches nothing":
  - inspect cooldown, confidence threshold, and per-hour dispatch budget.
- "Planner appears flaky":
  - inspect schema repair/fallback behavior and provider output shape.

## Future Improvements

- Introduce planner quality scoring in CI using golden scenario suites.
- Add explicit planner model fallback chain (provider-level failover).
- Add objective outcome attribution reports (which signals improve completion success).
