Additional global operating directives (PushPals)

You are operating inside the PushPals repository.

PushPals is a multi-device, always-on, multi-agent coding system designed to “run a small software team” around a repo with clear orchestration and auditability. It provides:
- apps/client: Expo (web/mobile) chat UI
- apps/server: event hub + persistence + queues (SQLite)
- apps/localbuddy: HTTP ingress + prompt enhancement
- apps/remotebuddy: orchestrator + scheduler (the “head”)
- apps/workerpals: execution daemons (host or Docker/OpenHands)
- apps/source_control_manager: merge/push daemon (serializes integration)

Core runtime model to keep in mind:
- Fast path: user → LocalBuddy → Server events → RemoteBuddy claims + emits progress → client renders via SSE/WS.
- Slow path: RemoteBuddy schedules WorkerPals → workers execute in isolated worktrees / Docker → workers produce per-job branches → completions queued → SourceControlManager merges/pushes into the integration branch (main_agents by default).

Repo-wide rules (apply to ALL components):
- First, read README.md (and any docs/ENHANCEMENTS/ROADMAP files you see referenced) before attempting any broad change. If you already know the repo, still re-scan the README when starting a new session or when proposing enhancements.
- Respect the repository’s existing conventions, architecture, and communication model (CommunicationManager in packages/shared).
- Preserve the orchestration semantics: LocalBuddy = ingress/enrichment, RemoteBuddy = scheduling/orchestration, WorkerPals = execution, SourceControlManager = integration/merge/push.

Change discipline:
- Prefer minimal, targeted changes over broad rewrites.
- Do not create or modify files unrelated to the user request.
- Keep runtime/scratch artifacts out of committed changes (no new logs, caches, outputs, or local temp data in the repo).
- If uncertain, choose the safest, least-destructive approach and validate via the smallest relevant checks.

Isolation & branching constraints:
- Worker execution must remain isolated: do not bypass the worktree/Docker isolation model.
- Do not perform integration/merge/push behaviors from worker contexts unless explicitly routed through SourceControlManager behavior.
- Avoid assumptions about the active workspace: SourceControlManager should not run directly in the user’s active worktree.

Communication & auditability:
- Ensure changes and progress are observable through the existing event model and lifecycle events where appropriate.
- Favor clear, structured status and error reporting over silent failures.
- When altering lifecycle or messaging behavior, maintain backwards compatibility unless explicitly changing the protocol.

Repo improvement power (when applicable):
- If you are RemoteBuddy (or acting as the system head), you may propose repo enhancements beyond the immediate request, but they must:
  - Align with README/project goals
  - Improve orchestration clarity, reliability, auditability, developer experience, or isolation safety
  - Be presented to the user as options (explore vs execute) when scope expands beyond the request
- Low-risk, clearly beneficial improvements (e.g., clarifying docs, tightening validation, small reliability fixes) may be included opportunistically if they do not broaden scope materially—call them out explicitly.

Operational safety:
- Never leak secrets from environment variables, local config, or logs.
- Avoid destructive operations unless explicitly requested and tightly scoped.
- Prefer deterministic, non-interactive commands and predictable outputs.

Definition of “done” across PushPals:
- The requested behavior works end-to-end in the correct component(s).
- Minimal relevant validation passes (lint/tests/typecheck/build slice as appropriate).
- The system remains aligned with the fast path / slow path model and does not regress isolation, orchestration, or auditability.
