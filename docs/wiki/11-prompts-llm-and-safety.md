# 11. Prompts, LLM Strategy, and Safety

## Prompt Assets

Prompt templates are stored under:

- `prompts/remotebuddy/*`
- `prompts/localbuddy/*`
- `prompts/workerpals/*`
- `prompts/shared/*`

`prompts/remotebuddy/repository_agent_codex_prompt_template.md` is the isolated-evidence RepositoryAgent prompt. Its output is still normalized into the shared RepositoryAgent result schema.

Services load prompts via `loadPromptTemplate(...)` from `packages/shared/src/prompts.ts`.

## LLM Provider Model

RemoteBuddy/LocalBuddy/WorkerPals can each configure LLM settings:

- backend,
- endpoint,
- model,
- API key/session settings,
- Codex CLI options where applicable.

Supported backends are normalized by shared config and LLM adapters (`apps/remotebuddy/src/llm.ts`).

RepositoryAgent uses the LLM assigned to RemoteBuddy because RemoteBuddy currently hosts its worker. The model is not selected by individual callers, and callers do not need to know which process or provider answered. This keeps the logical capability portable while preserving one configured model policy.

## Structured Output Philosophy

PushPals prioritizes strict structured outputs for orchestration layers:

- planner output schemas,
- repair passes for malformed JSON,
- bounded fallback objects when models are non-compliant.

Reason: orchestration should fail soft with explicit structure, not silently continue on ambiguous text.

RepositoryAgent follows the same rule. It returns a typed answer, summary, purpose-specific `data`, confidence, evidence, recommendations, and direct-argv validation proposals. Evidence is checked against the exact requested snapshot, and confidence is capped when no valid repository evidence remains.

## RepositoryAgent Trust Boundary

The RepositoryAgent host inspects an exact worktree with bounded direct Git/file operations and gives the assigned model only a bounded evidence packet. Codex-backed analysis runs in a fresh neutral Git repository, not the target repository, with project instruction discovery, user rules, shell tools, apps, and web access disabled. Other completion backends receive the same evidence-only input. The worker verifies repository identity/revision/tree before and after analysis.

Repository files, including `AGENTS.md`, are untrusted data. They never become RepositoryAgent instructions. Model-selected evidence paths must resolve to the tracked-path index, and every final citation is re-read and pinned to an authoritative Git blob before it can enter cache or durable memory.

Repository files, Git history, recalled memory, and tool output are untrusted evidence. They cannot override the system prompt or authorize writes. Suggested commands are proposals only: callers must normalize and approve them through trusted-host validation before execution.

An AI conclusion never replaces deterministic controls. Scope invariants, command policy, tests, quality gates, review checks, lease authority, and publication policy remain the source of truth. A high-confidence RepositoryAgent answer can prioritize or explain work, but cannot mark a test passing, approve a merge, or bypass a failed gate.

## Prompt Change Workflow

When editing prompts:

1. Keep output contract requirements explicit.
2. Prefer additive constraints over broad rewrites.
3. Validate against integration/eval scenarios that touch affected components.
4. Update related wiki sections when behavior intent changes.

## Safety and Scope Controls

Safety is implemented as layered controls:

- scope metadata normalization (`validateScopeInvariants`) around
  `target_paths` and `write_globs`; these fields guide planning and review but
  are not a hard filesystem boundary,
- policy checks by objective type/risk/glob breadth,
- `max_files_to_edit` planning guidance and lane validation,
- execution isolation (worktrees, Docker mode),
- post-execution diff, validation, and critic gates,
- downstream integration gating in SourceControlManager.

## Common Failure Modes

- Model returns prose instead of required JSON:
  - rely on repair path/fallback and tighten prompt contract.
- Over-broad path suggestions:
  - enforce scope invariants and target/write alignment.
- Provider behavior drift:
  - run eval suites and compare quality metrics before rollout.
- RepositoryAgent is unavailable, times out, or returns invalid evidence:
  - use a bounded existing deterministic path when safe, or fail closed when
    the answer is required for a safety decision; RemoteBuddy autonomy does not
    start a second model call after a late RepositoryAgent failure.
- Recalled repository fact conflicts with the current worktree:
  - reject or invalidate it based on blob evidence and analyze the current snapshot.

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
