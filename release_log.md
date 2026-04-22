# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.49`
- start_commit: `aaf83eff4065c7549b13d502581801fadf6ade55`
- end_commit: `dcdfad4f149a52fbc483ef2c02fca6ff0b09215b`
- commits_in_range: `1`

## Highlights

- Recover from stuck WorkerPal sandbox image inspection by treating timed-out local image metadata checks as rebuild signals instead of startup-stopping failures.
- Keep the runtime Docker executor on the same bounded image-inspection/build logic so RemoteBuddy and WorkerPals do not hang later on the same Docker image state.
- Preserve direct diagnostics when Docker commands still fail, but allow healthy rebuilds to repair a wedged local `pushpals-worker-sandbox:latest` automatically.

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
