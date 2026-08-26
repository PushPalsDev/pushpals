# 01. System Overview

## Why PushPals Exists

PushPals is built to solve a common failure mode in AI coding systems: great demos with weak operational discipline.

The design goal is not just "generate code". The goal is:

- make coding assistance reliable under real repository constraints,
- keep human operators in control,
- preserve auditability and replayability,
- support both interactive and autonomous work through the same pipeline.

## Product Modes

PushPals runs two modes in one architecture:

- Human-guided mode:
  - A user sends prompts from UI.
  - The system plans and executes with bounded scope.
- Autonomous mode:
  - `RemoteBuddy` periodically proposes bounded maintenance objectives.
  - Objectives are gated by policy, confidence, and budget constraints.

Both modes end up in the same request/job/completion queues so behavior is visible and debuggable in one place.

## Primary Components

- `apps/client`
  - Mission-control UI (Expo web/native).
- `apps/vscode-client`
  - VS Code extension client and stack orchestrator.
- `packages/cli`
  - Repo-aware terminal client and packaged runtime supervisor.
- `apps/localbuddy`
  - Fast ingress endpoint (`POST /message`) and lightweight handling.
- `apps/server`
  - Shared control plane: sessions, events, queues, RepositoryAgent broker, shared memory, and autonomy endpoints.
- `apps/remotebuddy`
  - Planner/orchestrator and autonomy engine; currently hosts the logical RepositoryAgent worker.
- `apps/workerpals`
  - Execution workers (host or Docker-isolated).
- `apps/source_control_manager`
  - Completion integration, merge pipeline, optional PR automation.
- `packages/protocol`
  - Event contracts, versioning, validators.
- `packages/shared`
  - Config loader, communication clients, repository identity/snapshot helpers, memory contract, and path/policy utilities.

RepositoryAgent is a logical capability rather than another required process. Any service can submit a typed repository question through the Server broker. The worker that answers it currently runs inside RemoteBuddy and uses RemoteBuddy's assigned LLM against the exact requested repository snapshot. This placement avoids another runtime process without making callers depend on RemoteBuddy internals.

## Core Architectural Choice

PushPals uses queue-mediated, event-driven orchestration instead of direct service-to-service RPC for task ownership.

Benefits:

- clear ownership boundaries,
- easier retries/recovery,
- better runtime introspection.

Costs:

- more queue state transitions,
- more moving parts to reason about,
- stricter requirements on idempotency and correlation IDs.

## System Invariants

These assumptions should remain true unless we intentionally redesign the platform:

- Requests and jobs are queue-mediated, not direct ad-hoc calls.
- RepositoryAgent work uses its own durable, leased queue; callers never call its RemoteBuddy host or database directly.
- Event history is replayable for session recovery.
- Execution and integration are separate responsibilities.
- Worker execution is isolated to a per-job repo worktree/sandbox; planning scope metadata guides relevance and review rather than acting as a filesystem write boundary.
- RepositoryAgent output is advisory. Deterministic policy, validation, execution, review, and publication gates remain authoritative.
- Shared memory is evidence-backed and repository-scoped; an LLM answer alone cannot promote a fact into an authoritative gate result.
- Human-guided and autonomous flows converge into the same control plane.

## Explicit Non-Goals

- Not a zero-setup SaaS product; local infrastructure is expected.
- Not a single-agent monolith optimized only for speed.
- Not a free-form autonomous executor without policy gates.

## What "Good" Looks Like In This Codebase

- Deterministic contracts where possible (`protocol`, JSON schemas, typed queues).
- Explicit scope constraints for writes (`target_paths`, `write_globs`, max files).
- Recoverability first (SQLite persistence, replay cursors, stale-claim sweeps, worktree isolation).
- Operational guardrails (timeouts, retry limits, lock leasing, startup preflights).

## Tradeoffs

Pros:

- high traceability for "why did this happen?",
- safer autonomous delegation,
- easier to test subsystems independently.

Cons:

- steeper onboarding than a single-process assistant,
- more configuration surface area,
- higher complexity in local startup and integration workflows.

## Quick Debug Map

- "UI is stale or missing history":
  - inspect session event cursor behavior first.
- "Job finished but code did not integrate":
  - inspect completion queue and SourceControlManager logs.
- "Planner output is inconsistent":
  - inspect RemoteBuddy planner schema handling and fallback path.
- "Repository guidance is missing or stale":
  - inspect the RepositoryAgent request, lease/deadline state, exact snapshot identity, and memory evidence references.
- "Autonomy did nothing":
  - inspect lock, cooldown, policy, and budget constraints.

## Future Improvements

- Introduce generated architecture docs from runtime metadata to keep diagrams in sync automatically.
- Add queue visualizer dashboards with per-stage latency histograms and SLA drift warnings.
- Add "component contracts" checks in CI (breaking change guardrails for queue payload shapes).
