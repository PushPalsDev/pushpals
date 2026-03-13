# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.6`
- start_commit: `bb7aa602055c732980cc15833b2a60ee3eea1f2c`
- end_commit: `4d8e53670909dd88d118212930c64dd0e05e5c58`
- commits_in_range: `3`

## Highlights

- Add CLI invocation logging regression coverage and harden CLI/remotebuddy tests.
- Stabilize embedded runtime bootstrap and monitor hub behavior in CLI.
- Improve shutdown lifecycle handling to reduce lingering embedded processes.

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
- Tag and push: `git tag v1.0.6 && git push origin v1.0.6`.
