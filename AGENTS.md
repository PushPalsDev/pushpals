# PushPals Codex Guidance

## Repository Workflows

- Before making a git commit in this repository, read `docs/git_commit.md` and follow it. The required sequence is `git pull --rebase`, then `git commit`, then `git push origin main`.
- Before cutting a release, read `docs/release_playbook.md` and follow it end-to-end. Do not tag, push tags, or trigger release publication from memory.
- Project-local Codex hooks in `.codex/hooks.json` reinforce these workflows. If a commit or release command is blocked, read the referenced workflow doc in the current Codex session, then retry the command.

## Scope Discipline

- Keep commits focused and stage only the intended files.
- Do not include unrelated local edits, runtime outputs, logs, caches, `node_modules`, or temporary files.
- Prefer updating the relevant docs in the same change when workflow behavior changes.
