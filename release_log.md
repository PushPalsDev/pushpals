# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.25`
- start_commit: `ed7666d4445534207a92200f7b357abba79035a5`
- end_commit: `eca182889064478cad33b0f865574248295631ec`
- commits_in_range: `1`

## Highlights

- Harden RemoteBuddy WorkerPal lifecycle cleanup so failed or unready workers do not accumulate after startup failures, Codex recycle paths, or CLI shutdown.
- Clean lingering WorkerPal warm Docker containers for the active repo during CLI startup preflight and embedded-runtime shutdown.
- Add an explicit `REMOTEBUDDY_MAX_WORKERPALS` override and reduce default WorkerPal concurrency plus warm-container CPU and memory limits to avoid workstation lockups.
- Add regression coverage for lingering warm-container cleanup and synchronous worker spawn failures.

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
- Tag and push: `git tag v1.0.25 && git push origin v1.0.25`.

