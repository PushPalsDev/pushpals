# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.59`
- start_commit: `cec8e75eb0c4807e24184f89621bd91b2a50fa93`
- end_commit: `7b1b22ec80928c60d13f9da736264ce7b5393d27`
- commits_in_range: `4`

## Highlights

- Recover Windows embedded CLI startup when the standalone `RemoteBuddy` runtime crashes with a Bun panic by swapping the managed service in place and rerunning a prebundled fallback asset under Bun instead of aborting the whole session.
- Ship the bundled `RemoteBuddy` fallback JS inside the CLI runtime asset set so the recovery path works from the extracted runtime tree without requiring a workspace install or `bun install`.
- Harden Windows runtime asset sync against transient `EBUSY` cleanup races during bundle and test cycles, and add forced-crash CLI E2E coverage for the exact fallback path on both Windows and WSL Ubuntu.
- Stabilize the hosted Windows release smoke by using deterministic OpenAI Codex API-key auth and accepting a logged WorkerPal warmup attempt with known Docker limitations as a valid runner outcome while still proving RemoteBuddy and server startup health.

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

- Docker-backed end-to-end coverage and hosted Windows smoke still depend on the underlying Docker daemon being healthy; when Docker Desktop itself is wedged, real-Docker integration runs will stall or downgrade until Docker is restarted.
