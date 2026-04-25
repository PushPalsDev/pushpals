# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.52`
- start_commit: `395a17a37919fb6574dc04b4f234b4e850b53f63`
- end_commit: `dc40f0a40646eb4728563f4c55640133990084dc`
- commits_in_range: `2`

## Highlights

- Extend `pushpals --clear` to remove PushPals-owned stale Docker artifacts, including repo-scoped warm containers and the local WorkerPal sandbox image tag.
- Standardize the shared Python worker logger contract so backend recovery paths can safely use Python-style logger methods without wrapper crashes.
- Auto-stage resolved merge-conflict files and continue prepared rebases when no conflict markers remain, while still failing fast on truly unresolved conflicts.

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
- Tag and push: `git tag v1.0.50 && git push origin v1.0.50`.
