# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.7`
- start_commit: `dbf6d854eab3d3d801a740278b7236435bb9f72c`
- end_commit: `dbf6d854eab3d3d801a740278b7236435bb9f72c`
- commits_in_range: `1`

## Highlights

- Unify CLI runtime preflight and runtime config usage so startup probes and embedded bootstrap use the same resolved settings.
- Defer embedded runtime tag lookup and release-asset downloads until auto-start is actually needed.
- Add shared client preflight wiring, packaged CLI runtime assets, and a local CLI integration sandbox for repo-side debugging.

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
- Tag and push: `git tag v1.0.7 && git push origin v1.0.7`.
