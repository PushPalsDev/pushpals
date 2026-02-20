# 11. Prompts, LLM Strategy, and Safety

## Prompt Assets

Prompt templates are stored under:

- `prompts/remotebuddy/*`
- `prompts/localbuddy/*`
- `prompts/workerpals/*`
- `prompts/shared/*`

Services load prompts via `loadPromptTemplate(...)` from `packages/shared/src/prompts.ts`.

## LLM Provider Model

RemoteBuddy/LocalBuddy/WorkerPals can each configure LLM settings:

- backend,
- endpoint,
- model,
- API key/session settings,
- Codex CLI options where applicable.

Supported backends are normalized by shared config and LLM adapters (`apps/remotebuddy/src/llm.ts`).

## Structured Output Philosophy

PushPals prioritizes strict structured outputs for orchestration layers:

- planner output schemas,
- repair passes for malformed JSON,
- bounded fallback objects when models are non-compliant.

Reason: orchestration should fail soft with explicit structure, not silently continue on ambiguous text.

## Safety and Scope Controls

Safety is implemented as layered controls:

- scope invariants (`validateScopeInvariants`) around `target_paths` and `write_globs`,
- policy checks by objective type/risk/glob breadth,
- write limits (`max_files_to_edit`) and lane enforcement,
- execution isolation (worktrees, Docker mode),
- downstream integration gating in SourceControlManager.

## Tradeoffs

Pros:

- safer autonomous behavior,
- better reliability under model variability,
- easier post-mortems thanks to structured traces.

Cons:

- prompt/schema maintenance overhead,
- strictness can reduce model flexibility in edge cases,
- requires frequent prompt evaluation as model behavior changes.

## Future Improvements

- Add prompt regression test packs with pass/fail scoring across model providers.
- Add auto-generated prompt changelogs linked to behavior metrics.
- Add model capability profiles to dynamically select prompt strictness levels.
