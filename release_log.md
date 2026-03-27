# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.26`
- start_commit: `40a5e24a53d0ab08f9826e0e3cf12774d6efd104`
- end_commit: `454f07ab8f5a0d502787724aa70b0fc07473e49b`
- commits_in_range: `2`

## Highlights

- Reuse one stable embedded runtime binary directory per platform and track the active runtime version with a `.runtime-tag` marker instead of rotating executable paths on every release.
- Clean up legacy per-tag runtime binary directories after successful refresh so stale executable trees do not accumulate across upgrades.
- Add optional cross-platform release signing hooks: Authenticode for Windows artifacts, `codesign` for macOS artifacts, and detached GPG signatures for Linux release assets.
- Migrate stale embedded runtime `configs/local.toml` autonomy overrides back to `remotebuddy.autonomy.enabled = true` so the autonomous engine stays enabled by default after CLI upgrades.
- Add regression coverage for stable runtime binary layout reuse and embedded autonomy migration during CLI runtime preparation.

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
- Tag and push: `git tag v1.0.26 && git push origin v1.0.26`.

