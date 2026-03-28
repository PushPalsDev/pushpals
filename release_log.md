# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.29`
- start_commit: `cda84148b233ce59d44851c4aa375307ef558468`
- end_commit: `52a653b558994cfcc31bff76369079e9706d3662`
- commits_in_range: `3`

## Highlights

- Expand CLI config coverage around embedded-runtime seeding, repo-config mode, and stale runtime override handling, and fix repo-config runs so stale embedded config env vars cannot bleed into the child runtime.
- Dedupe narrow file-targeted WorkerPal tasks so concurrent requests against the same concrete file set reuse the active task instead of racing duplicate edits, and harden SourceControlManager startup status transitions.
- Clean lingering `_source_control_manager/*` temp branches and stale WorkerPal `job-*` worktrees on startup and shutdown so quitting PushPals leaves repo-local git worktrees in a clean state.

## Install

```bash
npm i -g @pushpalsdev/cli
```

```bash
bun install -g @pushpalsdev/cli
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Breaking Changes

- None.

## Known Issues

- None.

## Release Checklist

- Confirm `release_log.md` content before tagging.
- Tag and push: `git tag v1.0.29 && git push origin v1.0.29`.

