# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.44`
- start_commit: `d3a5ff6075594c2ca512a3c9fd0d4ad81a23c71a`
- end_commit: `f56edd0d429523d110bb6772f630c4793ef3b319`
- commits_in_range: `1`

## Highlights

- Treat merge-conflict repair jobs as a stricter quality-gate mode so they can no longer soft-pass exhausted auto-revisions while an unfinished rebase is still active.
- Fail merge-conflict executions immediately when the worker returns with an in-progress git sequencer instead of drifting into validation and later dying during commit finalization.
- Add regression coverage for the merge-conflict quality policy override and the fail-fast execution path when a sandbox repo is still paused mid-rebase.

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
- Tag and push: `git tag v1.0.44 && git push origin v1.0.44`.
