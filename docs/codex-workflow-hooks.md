# Codex Workflow Hooks

This repository uses Codex guidance plus project-local hooks to keep commit and
release workflows consistent.

## Files

- `AGENTS.md` gives Codex durable repo instructions.
- `.codex/hooks.json` registers project-local Codex lifecycle hooks.
- `.codex/hooks/repo_workflow_guard.mjs` injects workflow reminders and blocks
  commit/release shell commands until the required docs have been read in the
  current Codex session.
- `docs/git_commit.md` defines the required direct-to-main commit flow.
- `docs/release_playbook.md` defines the release flow.

## Behavior

- On Codex session start, the hook adds context reminding Codex to use
  `docs/git_commit.md` for commits and `docs/release_playbook.md` for releases.
- When a user prompt mentions committing or cutting a release, the hook adds
  task-specific context pointing Codex at the required doc.
- Before shell commands, the hook blocks:
  - `git commit` until `docs/git_commit.md` was read and `git pull --rebase` was run.
  - `git push origin main` until `docs/git_commit.md` was read.
  - release tags or release publication commands until
    `docs/release_playbook.md` was read.

The hook stores per-session state under `.git/codex-workflow-guard/`, so it does
not create publishable files.

## Trusting Hooks

Project-local Codex hooks only run after the project `.codex/` layer is trusted.
In the Codex CLI, use `/hooks` to inspect and trust the hook definitions after
they are added or changed.

If the hook blocks a legitimate command, read the referenced workflow doc in the
same Codex session and retry.

## Limits

Hooks are guardrails, not a complete security boundary. They reinforce the
normal instructions in `AGENTS.md`; they do not replace human review, CI, or
release discipline.
