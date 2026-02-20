# 03. Configuration and Environments

## Configuration Philosophy

PushPals intentionally uses a layered config model:

- TOML for stable, typed runtime behavior.
- `.env` for deployment wiring and secrets.
- A single shared config loader (`packages/shared/src/config.ts`) to normalize both.

This is the main abstraction boundary that prevents downstream code churn when config keys move between TOML and env.

## Source of Truth Layers

1. `config/default.toml`
   - baseline defaults for all services.
2. `config/<profile>.toml`
   - profile-specific overrides (via `PUSHPALS_PROFILE`).
3. `config/local.toml`
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
3. Update `.env.example` and `config/local.example.toml` guidance.
4. Remove old read paths only after all callers use the unified typed field.

## Operationally Important Knobs

- Server:
  - host/port, stale-claim recovery windows.
- RemoteBuddy:
  - poll intervals, worker spawn policy, execution/finalization budgets.
- RemoteBuddy autonomy:
  - tick interval, candidate limits, confidence gates, dispatch quotas, cooldown windows.
- WorkerPals:
  - backend selection, runtime timeouts, Docker warm/jitter policy.
- SourceControlManager:
  - integration branch/base branch, merge strategy, PR behavior.
- Startup:
  - preflight behavior, image rebuild policy, LLM startup behavior.

## Secrets Guidance

Keep secrets out of TOML and in `.env` or secret stores:

- API keys (`OPENAI_API_KEY`, per-service keys),
- auth tokens,
- git/github tokens.

The repository templates (`.env.example`, `config/local.example.toml`) are intentionally non-secret.

## Common Misconfiguration Symptoms

- Wrong LLM backend/endpoint:
  - services boot but generation fails at runtime.
- Missing `config/local.toml` or `.env`:
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
