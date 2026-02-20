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
- `apps/localbuddy`
  - Fast ingress endpoint (`POST /message`) and lightweight handling.
- `apps/server`
  - Shared control plane: sessions, events, queues, autonomy endpoints.
- `apps/remotebuddy`
  - Planner/orchestrator and autonomy engine.
- `apps/workerpals`
  - Execution workers (host or Docker-isolated).
- `apps/source_control_manager`
  - Completion integration, merge pipeline, optional PR automation.
- `packages/protocol`
  - Event contracts, versioning, validators.
- `packages/shared`
  - Config loader, communication client, path/policy utilities.

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
- Event history is replayable for session recovery.
- Execution and integration are separate responsibilities.
- Write scope is bounded by planning/policy metadata.
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
- "Autonomy did nothing":
  - inspect lock, cooldown, policy, and budget constraints.

## Future Improvements

- Introduce generated architecture docs from runtime metadata to keep diagrams in sync automatically.
- Add queue visualizer dashboards with per-stage latency histograms and SLA drift warnings.
- Add "component contracts" checks in CI (breaking change guardrails for queue payload shapes).
