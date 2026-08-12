# 03. Configuration and Environments

## Configuration Philosophy

PushPals intentionally uses a layered config model:

- TOML for stable, typed runtime behavior.
- `.env` for deployment wiring and secrets.
- A single shared config loader (`packages/shared/src/config.ts`) to normalize both.

This is the main abstraction boundary that prevents downstream code churn when config keys move between TOML and env.

## Source of Truth Layers

1. `configs/default.toml`
   - baseline defaults for all services.
2. `configs/<profile>.toml`
   - profile-specific overrides (via `PUSHPALS_PROFILE`).
3. `configs/local.toml`
   - machine-local, gitignored overrides.
4. `.env`
   - URLs, tokens, API keys, deployment wiring.
5. CLI flags
   - final runtime overrides for service entrypoints.

## Env vs TOML Decision Rule

Use TOML for:

- non-secret runtime behavior,
- policy and timeout knobs,
- stable defaults that should be versioned.

Use `.env` for:

- secrets and tokens,
- deployment-specific endpoints,
- CI/runtime wiring that should not be committed.

## Why This Design Works

The loader in `packages/shared/src/config.ts` centralizes:

- type coercion,
- defaults,
- alias normalization (`openai_compatible` -> `lmstudio`, etc.),
- env/TOML precedence,
- path resolution to project root.

Downstream services consume one typed `PushPalsConfig` shape instead of manually reading env values.

## Migration Pattern (Env <-> TOML)

When moving a setting between env and TOML:

1. Update `packages/shared/src/config.ts` first.
2. Keep backward-compatible fallback reads during migration window.
3. Update `.env.example` and `configs/local.example.toml` guidance.
4. Remove old read paths only after all callers use the unified typed field.

## Operationally Important Knobs

- Server:
  - host/port, stale-claim recovery windows.
- RemoteBuddy:
  - poll intervals, worker spawn policy, execution/finalization budgets.
- RemoteBuddy memory:
  - `remotebuddy.memory.enabled`
  - `remotebuddy.memory.include_cross_session`
  - `remotebuddy.memory.max_recall_items`
  - `remotebuddy.memory.max_recall_chars`
  - `remotebuddy.memory.max_summary_chars`
  - `remotebuddy.memory.retention_days`
- RemoteBuddy autonomy:
  - tick interval, candidate limits, confidence gates, dispatch quotas, cooldown windows.
- WorkerPals:
  - backend selection, runtime timeouts, Docker warm/jitter policy,
    `workerpals.dependency_preparation_timeout_ms` (or
    `WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS`).
- SourceControlManager:
  - integration branch/base branch, merge strategy, PR behavior.
- SourceControlManager ReviewAgent:
  - `source_control_manager.review_agent.enabled`
  - `source_control_manager.review_agent.poll_interval_ms`
  - `source_control_manager.review_agent.pass_threshold`
  - `source_control_manager.review_agent.merge_method`
  - `source_control_manager.review_agent.reviewer_md_path`
  - `source_control_manager.review_agent.codex_*`
- Startup:
  - preflight behavior, image rebuild policy, LLM startup behavior.

## Memory/Review Env Overrides

Examples of high-impact env overrides supported by the shared config loader:

- `REMOTEBUDDY_MEMORY_ENABLED`
- `REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION`
- `REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS`
- `REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS`
- `REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS`
- `REMOTEBUDDY_MEMORY_RETENTION_DAYS`
- `SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD`
- `SOURCE_CONTROL_MANAGER_REVIEW_AGENT_POLL_INTERVAL_MS`

## Secrets Guidance

Keep secrets out of TOML and in `.env` or secret stores:

- API keys (`OPENAI_API_KEY`, per-service keys),
- auth tokens,
- git/github tokens.

The repository templates (`.env.example`, `configs/local.example.toml`) are intentionally non-secret.

## Common Misconfiguration Symptoms

- Wrong LLM backend/endpoint:
  - services boot but generation fails at runtime.
- Missing `configs/local.toml` or `.env`:
  - startup preflight fails.
- Branch/base mismatch in integration config:
  - SourceControlManager push/merge behavior appears inconsistent.

## Tradeoffs

Pros:

- explicit and reviewable config state,
- fewer "hidden env var" bugs,
- easier reproducibility across machines.

Cons:

- larger config surface area,
- needs disciplined naming and deprecation handling,
- requires good docs to stay approachable.

## Future Improvements

- Add generated config reference docs directly from the typed config interface.
- Add startup-time "unused config key" warnings to catch stale entries.
- Add schema validation for TOML with line-numbered diagnostics.
