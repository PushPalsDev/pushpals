# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.54`
- start_commit: `0790d2c147334f959146ee5dfdbd7046ac6b6fa9`
- end_commit: `009ed9e7ad5b5096b7616df36438191dd475a217`
- commits_in_range: `3`

## Highlights

- Fix merge-conflict quality gating so prepared conflict paths still count after the sandbox rebase auto-continues, and classify missing dependencies/imports as repo blockers instead of wasting revision retries.
- Relax the test assertion-balance heuristic after focused validation really passes, preventing false failures when negative coverage is expressed through invariants like unchanged counts or `.not` assertions.
- Soft-pass exhausted quality revisions for publishable review-fix and merge-conflict PR updates so WorkerPals still pushes the revision while keeping unfinished rebases and real repo/environment blockers as hard failures.

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
