# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.9`
- start_commit: `994b1a1d77b52d0440590bef938c1f94bfa5e779`
- end_commit: `994b1a1d77b52d0440590bef938c1f94bfa5e779`
- commits_in_range: `1`

## Highlights

- Unify CLI monitoring on the packaged client hub and remove the legacy inline monitor fallback path.
- Enforce auth consistently across session creation, SSE, WebSocket, and session message routes, with browser-safe query fallback for stream transports.
- Add packaged CLI integration coverage so local debugging validates the built package path and package-relative monitor/runtime assets.

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
- Tag and push: `git tag v1.0.9 && git push origin v1.0.9`.
