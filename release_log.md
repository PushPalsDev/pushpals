# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.35`
- start_commit: `cc8243f6701759e71b783d6d167fbddeb7a97b37`
- end_commit: `10ebb243436328c1a60cc1687d1730a945e178b3`
- commits_in_range: `1`

## Highlights

- Prevent workers from claiming a second job while another claim is still active, which stops stale orphaned claimed rows from being auto-failed later by the server watchdog.
- Add regression coverage for the single-active-claim invariant and stale-recovery interaction so worker/job state cannot drift out of sync unnoticed.

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
- Tag and push: `git tag v1.0.35 && git push origin v1.0.35`.
