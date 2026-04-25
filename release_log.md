# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.51`
- start_commit: `83ca619610077a1ae4937ca3865b34d12538f293`
- end_commit: `9ec9cbf1448571fda9fa4945d711abb36bfc17f6`
- commits_in_range: `1`

## Highlights

- Recover OpenAI Codex worker runs from disallowed shell-wrapper retries by injecting direct-command guidance up front and retrying once with unwrapped direct commands when safe.
- Restore autonomy PR feedback learning by resolving `patternKey` and objective context from queued job metadata when direct objective linkage is missing.
- Defer background autonomy ideation while WorkerPals are busy, and prewarm a second worker when open unmerged PR backlog exists so active user and PR work gets priority.

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
- Tag and push: `git tag v1.0.50 && git push origin v1.0.50`.
