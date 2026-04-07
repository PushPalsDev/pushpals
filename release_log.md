# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.39`
- start_commit: `b9f904291ccd875edda75723fb80ff232917eca2`
- end_commit: `6c890c6ccad84f7f4a38eb31af53c75905641ed1`
- commits_in_range: `2`

## Highlights

- Isolate WorkerPal heartbeats from queued progress delivery, add control-plane request timeouts, and recycle unhealthy workers before stale-claim failures cascade.
- Add live integration coverage for blocked control-plane and finalization-heartbeat scenarios to keep WorkerPal reliability pinned down.
- Quiesce service supervision before graceful CLI shutdown so managed services do not schedule restarts while the runtime is intentionally exiting.
- Harden the full-stack integration harness for Windows temp paths and `git core.longpaths` while preserving strict single-worker isolation.

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
- Tag and push: `git tag v1.0.39 && git push origin v1.0.39`.
