# 12. Operations, Testing, and Roadmap

## Startup and Runtime Operations

Primary startup flow:

- `bun run start`

This runs preflight checks in `scripts/start.ts` before launching the full stack:

- required config files,
- LLM endpoint readiness and optional LM Studio bootstrap,
- integration branch/worktree safety,
- worker Docker image readiness,
- startup warmup job path.

Useful alternatives:

- `bun run dev:full` for direct multi-service launch.
- individual `*:only` scripts for targeted debugging.

## Fast Runbook Commands

- Primary Bun suite:
  - `bun run test`
- Full stack with preflights:
  - `bun run start`
- Full stack without preflight wrapper:
  - `bun run dev:full`
- Integration harness:
  - `bun run test:integration`
- Eval harness:
  - `bun run test:integration:eval`
- Focused runtime end-to-end suites:
  - `bun run test:cli:e2e`
  - `bun run test:workerpals:e2e`
  - `bun run test:start:e2e`
- Consolidated reliability contract:
  - `bun run harness:reliability`
- VS Code extension package/lint:
  - `bun run vscode:client:lint`
  - `bun run vscode:client:package`

## Local Environment Expectations

Baseline tooling:

- Bun 1.3.14+
- Node.js 20+ for the npm-installed CLI launcher
- Python 3.12+
- Docker (for default worker flow)
- Git (and optionally GitHub CLI for PR workflows)

The source-checkout `bun run start` path launches the Server, RemoteBuddy, a
Docker WorkerPal, SourceControlManager, and the offline-capable Expo client;
LocalBuddy is added only while `localbuddy.enabled=true`. The CLI packages the
same responsibilities differently: non-Windows hosts use release binaries,
while Windows launches embedded source bundles. VS Code uses that installed
CLI runtime-only path for repositories that are not PushPals source checkouts.

## Logging and Debugging

Where to look first:

- service terminal logs from `dev:full` or `start`.
- server queue snapshots (`/requests`, `/jobs`, `/completions`).
- WorkerPals logs and job logs in Server job log endpoints.
- integration logs from SourceControlManager.

For session behavior:

- inspect event stream (`/sessions/:id/events` with cursor replay semantics).

## Incident Triage Order

When the system is "stuck", diagnose in this order:

1. Server health and session event progression.
2. Request queue movement.
3. Job queue movement and worker heartbeat.
4. Completion queue movement and SCM processing.
5. Client transport/reconnect state.

Autonomy safety freezes are evidence-scoped. A degraded-health evidence set
may trigger one timed evaluator freeze; once that freeze expires, unchanged
evidence constrains dispatch instead of extending the freeze forever. New
terminal evidence can trigger a new freeze. Hourly token and runtime budget
pauses remain hard limits until their rolling window recovers.

## Testing Layers

- Primary root suite:
  - `bun run test` runs prompt-policy enforcement, `bun test tests`, and the
    standalone protocol integration script.
  - It does not discover tests colocated under `apps/**/src` or Python backend
    unit tests.
- Colocated/service checks:
  - `bun run vscode:client:test`
  - `bun --cwd apps/localbuddy test`
  - `bun test apps/remotebuddy/src`
  - `bun run protocol:typecheck`
  - `bun run vscode:client:lint`
- Python backend unit tests are executable directly:
  - `python apps/workerpals/src/backends/shared/test_settings_resolver.py`
  - `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
  - `python apps/workerpals/src/backends/openhands/test_openhands_runtime_paths.py`
- End-to-end integration harness:
  - `tests/integration/integration_controller.py`
  - `tests/integration/test_workerpals_e2e.py`
- Reliability contract:
  - `scripts/reliability-harness.ts` runs the failure-evidence,
    durable-lifecycle, repair-orchestration, and runtime-boundary phases.
  - Linux dependency-projection/container checks and the Windows-host/Linux-
    container worktree boundary are opt-in; use
    [`docs/reliability-harnesses.md`](../reliability-harnesses.md) for the exact
    environment flags.
- Eval scenarios:
  - `tests/integration/eval_scenarios.swebench_like.json`

The integration controller supports two modes:

- `integration`: regular flow checks.
- `eval`: backend quality benchmark runs with scenario suites and budgets.

## Tradeoffs

Pros:

- strong operational discipline and reproducibility,
- realistic benchmark path for backend quality.

Cons:

- setup complexity is higher than simple single-agent tools,
- Docker and multi-service orchestration increase local troubleshooting load.

## Future Improvements

1. Observability

- distributed trace IDs across request/job/completion lifecycle,
- richer metrics and dashboards for latency, failure categories, and retries.

2. Reliability

- dead-letter queues and replay tools,
- stronger backpressure and overload controls.

3. DX

- one-command diagnostics report,
- clearer startup failure classification with remediation hints.

4. Autonomy quality

- clearer operator-visible explanations for existing objective outcome and
  RepositoryAgent feedback attribution,
- model/prompt benchmark gating before production rollout.

5. Platform hardening

- stricter schema evolution checks,
- stronger integration of policy checks into CI.
