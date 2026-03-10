# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.2`
- start_commit: `4da141e0a7f26e7b99ba4f00611b93ae47385753`
- end_commit: `2fc68cca8a305a2d714c1a0f6d64523d70fcd328`
- commits_in_range: `2`

## Highlights

- Auto-start SourceControlManager as part of embedded CLI bootstrap when LocalBuddy is unavailable.
- Release prep update for `v1.0.2`.

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
- Tag and push: `git tag v1.0.2 && git push origin v1.0.2`.
