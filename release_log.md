# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.22`
- start_commit: `2da4c7565d3f532a99c009eef507a5c15f9ef790`
- end_commit: `2da4c7565d3f532a99c009eef507a5c15f9ef790`
- commits_in_range: `1`

## Highlights

- Reorder the CLI release workflow so GitHub release assets and embedded runtime binaries are published before `@pushpalsdev/cli` is published to npm.
- Remove the release sequencing window where npm could publish a new CLI version before the matching `pushpals-runtime-*` assets existed for that tag.
- Prevent installed CLI versions from resolving a fresh runtime tag and immediately hitting GitHub 404s during embedded runtime bootstrap.
- Keep the standalone CLI binary build flow unchanged while making npm publication explicitly depend on successful GitHub release asset publication.

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
- Tag and push: `git tag v1.0.22 && git push origin v1.0.22`.

