# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.58`
- start_commit: `cec8e75b79f67bc5b6e272f34c2ca6ebc0b5377`
- end_commit: `bdd3fae676d09d4d11279420d7ccd792b7887550`
- commits_in_range: `2`

## Highlights

- Recover Windows embedded CLI startup when the standalone `RemoteBuddy` runtime crashes with a Bun panic by swapping the managed service in place and rerunning a prebundled fallback asset under Bun instead of aborting the whole session.
- Ship the bundled `RemoteBuddy` fallback JS inside the CLI runtime asset set so the recovery path works from the extracted runtime tree without requiring a workspace install or `bun install`.
- Harden Windows runtime asset sync against transient `EBUSY` cleanup races during bundle/test cycles and add regression coverage for the exact forced-crash recovery path.
- Expand Windows smoke coverage to cold-start against a real repo path and repo data dir, and validate the fallback path end to end on both Windows and WSL Ubuntu.

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

- The packaged CLI now recovers from the observed Windows `RemoteBuddy` standalone crash path, but Docker-backed end-to-end suites still depend on the local Docker daemon being healthy; when Docker Desktop itself is wedged, the real-Docker integration tests will stall or skip until Docker is restarted.
