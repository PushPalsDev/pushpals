# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.69`
- start_commit: `e382b45f72b63d0594f39791cbf8b9e8285af6b3`
- end_commit: `65e0e26d9a6bb2ee8c2c9e5d4ccf98ee58e040f6`
- commits_in_range: `1`

## Highlights

- Make `pushpals --clear` treat unavailable Docker as a best-effort cleanup skip instead of a hard failure.
- Fix the published Windows CLI smoke failure when Docker Desktop is not present on the runner.
- Add Docker-unavailable classification for common Windows named-pipe and Linux daemon connection errors.
- Shut down the embedded runtime with a final best-effort `pushpals --clear` after installed-package smoke readiness checks, reducing lingering startup/runtime processes.
- Ignore local dev package version `0.0.0-dev` when resolving embedded runtime release tags, so local tarball smoke does not target a non-existent `v0.0.0-dev` runtime release.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; this release only makes cleanup tolerate Docker being unavailable.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
