# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.1`
- start_commit: ``
- end_commit: ``
- commits_in_range: `0`

## Highlights

- Publish `@pushpals/cli` on npm for global install.
- Attach standalone binaries for Windows, Linux, and macOS to GitHub Releases.
- Add tag-driven release automation for npm + binary artifacts.

## Install

```bash
npm i -g @pushpals/cli
```

```bash
bun install -g @pushpals/cli
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

- Update this file with release-specific notes.
- Confirm npm package/version and platform artifacts.
- Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
