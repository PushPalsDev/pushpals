# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.5`
- start_commit: `a1f7bcafa8d2506a433e5b6d0288083a1f5ffde4`
- end_commit: `a1f7bcafa8d2506a433e5b6d0288083a1f5ffde4`
- commits_in_range: `1`

## Highlights

- Add startup invocation telemetry in CLI for faster first-hop diagnostics.
- Print CLI version/runtime/platform/cwd/args at process entry.

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
- Tag and push: `git tag v1.0.5 && git push origin v1.0.5`.
