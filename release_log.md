# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.41`
- start_commit: `d3822d4eab19688ce8378db63c147f588f5892d2`
- end_commit: `6fcf92dc5084d84c052dbd371d53ae336f75f622`
- commits_in_range: `8`

## Highlights

- Fix packaged CLI shutdown on Unix by preserving graceful embedded runtime shutdown ordering so RemoteBuddy can clean up auto-spawned WorkerPals before the CLI falls back to force-stop.
- Harden packaged CLI Linux E2E coverage with bounded cleanup, drained child output, non-TTY-safe interaction, and a dedicated supervisor restart/status probe path.
- Improve embedded runtime reliability by stabilizing WorkerPal control-plane behavior and reusing the shared Docker image across the CLI E2E suite for faster, less flaky runs.

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
- Tag and push: `git tag v1.0.41 && git push origin v1.0.41`.
