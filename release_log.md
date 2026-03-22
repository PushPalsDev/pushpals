# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.16`
- start_commit: `b7eccf752996cdaee64a396f8ecefc3bb01dc740`
- end_commit: `b7eccf752996cdaee64a396f8ecefc3bb01dc740`
- commits_in_range: `1`

## Highlights

- Add WorkerPal to the embedded CLI runtime artifact set so installed `pushpals` releases can bootstrap a WorkerPal backend instead of assuming a source checkout layout.
- Update the release pipeline to compile and publish `pushpals-runtime-workerpals` binaries for Windows, macOS, and Linux alongside the existing runtime services.
- Teach RemoteBuddy to prefer an embedded WorkerPal binary when available, while retaining source-checkout fallback for local development.
- Correct the WorkerPal spawn contract so execution happens against the target repo root and passes `--repo` explicitly, rather than changing cwd to `apps/workerpals`.
- Prevent false user-facing delegation confirmations by only announcing WorkerPal handoff after worker availability has been established.
- Extend CLI/runtime tests to cover the embedded WorkerPal artifact path and the revised WorkerPal spawn command shape.

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
- Tag and push: `git tag v1.0.16 && git push origin v1.0.16`.
