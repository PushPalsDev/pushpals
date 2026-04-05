# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.36`
- start_commit: `ba05a49f830887c840ff8caf47e3a88922cff9fd`
- end_commit: `56d3defb250475543a9454604b00b13f67fa1a4f`
- commits_in_range: `1`

## Highlights

- Add end-to-end coverage for host-managed service recovery, including a full-stack `bun run start` failure path that exits non-zero after repeated fatal server crashes.
- Add dedicated service-manager integration coverage for restart exhaustion and package a `bun run test:start:e2e` command so host-mode reliability checks are easy to run.

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
- Tag and push: `git tag v1.0.36 && git push origin v1.0.36`.
