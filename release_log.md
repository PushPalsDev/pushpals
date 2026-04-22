# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.48`
- start_commit: `0e528e542c0976b7a969299fb60344704849c969`
- end_commit: `727a69631da497550cefced2c41cd84aa90d08cd`
- commits_in_range: `1`

## Highlights

- Add explicit timeout bounds for Docker version probing, WorkerPal sandbox image inspection, and sandbox image rebuilds during CLI startup.
- Surface progress logging before the WorkerPal sandbox image precheck so Docker Desktop or WSL stalls no longer look like a frozen `pushpals` startup.
- Fail fast with a direct sandbox-image inspection error when the local Docker daemon hangs instead of waiting indefinitely after embedded runtime assets are prepared.

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
- Tag and push: `git tag v1.0.46 && git push origin v1.0.46`.
