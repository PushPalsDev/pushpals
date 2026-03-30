# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.32`
- start_commit: `d8ba5221b23c021ece8bad843b96474a57e5edac`
- end_commit: `a8e1ee85b7fe8bc39a100f7a4f85faa5e5f87306`
- commits_in_range: `1`

## Highlights

- Restore packaged SourceControlManager ReviewAgent execution in installed and standalone CLI runtimes by resolving bundled review prompts correctly, handing embedded runtime services a concrete Bun executable, and fixing temp-branch cleanup during review polling.

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
- Tag and push: `git tag v1.0.32 && git push origin v1.0.32`.

