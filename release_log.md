# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.3`
- start_commit: `7e6285e1cd2502c78d491d1523bcc0c85238d928`
- end_commit: `7e6285e1cd2502c78d491d1523bcc0c85238d928`
- commits_in_range: `1`

## Highlights

- Replace runtime `git clone` bootstrap with release-tagged binary runtime services.
- CLI auto-start now downloads runtime binaries/assets and launches server/localbuddy/remotebuddy/source_control_manager from binaries.
- Add runtime tag selection (`--runtime-tag`) and release workflow support for publishing runtime service binaries.

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
- Tag and push: `git tag v1.0.3 && git push origin v1.0.3`.
