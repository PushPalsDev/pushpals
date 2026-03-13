# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.8`
- start_commit: `0af4188bb8042b56072990c87212c7329e302b79`
- end_commit: `0af4188bb8042b56072990c87212c7329e302b79`
- commits_in_range: `1`

## Highlights

- Add CLI regression coverage around external-tool seams including git command discovery, platform launcher selection, and Windows service stop handling.
- Add SourceControlManager git executable override tests so embedded SCM honors the same `PUSHPALS_GIT_BIN` contract as CLI bootstrap.
- Expose small CLI helper seams for deterministic testing of platform-specific process-launch behavior without brittle end-to-end mocking.

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
- Tag and push: `git tag v1.0.8 && git push origin v1.0.8`.
