# PushPals Documentation

The `docs` directory is the right place for a project wiki. It does not need to be renamed to `wiki`.

This repository now uses `docs/wiki/` as a structured, wiki-style knowledge base for onboarding, architecture, and operations.

## Maintainer References

- `docs/git_commit.md` - Required direct-to-main commit flow: `git commit`, `git pull --rebase`, then `git push`
- `docs/codex-workflow-hooks.md` - Codex hook setup that reinforces commit and release workflows
- `docs/release_playbook.md` - Tag-driven CLI release checklist
- `release_log.md` - Current release notes and metadata used by release publication

## Wiki Index

- `docs/wiki/README.md` - Navigation and learning paths
- `docs/wiki/01-system-overview.md` - Motivation, goals, and system model
- `docs/wiki/02-runtime-architecture.md` - End-to-end runtime architecture and queues
- `docs/wiki/03-configuration-and-environments.md` - Config model (`.env` + TOML) and environment strategy
- `docs/wiki/04-server-control-plane.md` - Server internals and persistence model
- `docs/wiki/05-localbuddy.md` - LocalBuddy behavior and request ingress
- `docs/wiki/06-remotebuddy.md` - RemoteBuddy planner and autonomy loop
- `docs/wiki/07-workerpals.md` - Worker execution, Docker isolation, and backend model
- `docs/wiki/08-source-control-manager.md` - Integration pipeline and merge orchestration
- `docs/wiki/09-client-surfaces.md` - Expo client and VS Code extension
- `docs/wiki/10-shared-packages-and-protocol.md` - `packages/shared` and `packages/protocol`
- `docs/wiki/11-prompts-llm-and-safety.md` - Prompting strategy, structured outputs, and guardrails
- `docs/wiki/12-operations-testing-and-roadmap.md` - Startup, operations, testing, and future roadmap

## Maintenance Notes

- Keep component ownership docs aligned with code changes.
- Prefer updating the relevant wiki page in the same PR as behavioral changes.
- Keep `docs/git_commit.md`, `docs/release_playbook.md`, and `release_log.md` aligned with maintainer workflow changes.
- Treat these docs as operational references, not marketing copy.
