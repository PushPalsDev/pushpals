# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.4`
- start_commit: `af4160c467a17016a5e351ad1e754c1300c076bc`
- end_commit: `af4160c467a17016a5e351ad1e754c1300c076bc`
- commits_in_range: `1`

## Highlights

- Fix release workflow runtime binary builds by generating protocol workspace artifacts before compile.
- Resolve CI failure where runtime service binary compile could not resolve `protocol` on clean runners.

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
- Tag and push: `git tag v1.0.4 && git push origin v1.0.4`.
