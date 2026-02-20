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

## Local Environment Expectations

Baseline tooling:

- Bun
- Python 3.12+
- Docker (for default worker flow)
- Git (and optionally GitHub CLI for PR workflows)

## Logging and Debugging

Where to look first:

- service terminal logs from `dev:full` or `start`.
- server queue snapshots (`/requests`, `/jobs`, `/completions`).
- WorkerPals logs and job logs in Server job log endpoints.
- integration logs from SourceControlManager.

For session behavior:

- inspect event stream (`/sessions/:id/events` with cursor replay semantics).

## Testing Layers

- Unit/integration tests (TypeScript + Python harnesses).
- End-to-end integration harness:
  - `tests/integration/integration_controller.py`
  - `tests/integration/test_workerpals_e2e.py`
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

- objective outcome attribution loops,
- model/prompt benchmark gating before production rollout.

5. Platform hardening

- stricter schema evolution checks,
- stronger integration of policy checks into CI.
