# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.53`
- start_commit: `3c74ec86ab8f29f420d2387588a7dc796746e921`
- end_commit: `00c601ea5d30378f34f8b2edd28a638e6b83ed1f`
- commits_in_range: `1`

## Highlights

- Fix `RemoteBuddy` worker startup so a freshly spawned WorkerPal that comes online already `busy` is treated as healthy instead of being killed as "not ready."
- Prevent queued work from being stranded behind false startup timeouts that later surface as stale-claim job failures.
- Add regression coverage for the busy-on-startup worker path so startup readiness stays separate from idle-capacity selection.

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
- Tag and push: `git tag v1.0.53 && git push origin v1.0.53`.
