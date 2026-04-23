# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.50`
- start_commit: `a7282aa2e7f3a46d471c19b9c108e52550e1faed`
- end_commit: `94595c8f8e6927d4ab2ab76b63d109901c4e30c0`
- commits_in_range: `1`

## Highlights

- Promote the Windows host Docker path into always-on CLI E2E coverage on self-hosted `windows/x64/docker` runners.
- Run both packaged CLI E2E and WorkerPals control-plane E2E on the Windows Docker host path so Docker Desktop/WSL regressions are exercised before release.
- Keep Linux packaged CLI and WorkerPals control-plane lanes active, giving the workflow coverage across both native Linux Docker and Windows-hosted Docker sandbox paths.

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
- Tag and push: `git tag v1.0.50 && git push origin v1.0.50`.
