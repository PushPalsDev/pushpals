# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.21`
- start_commit: `8906f269ae7c69a5586f22cc586f89dc85b5ba55`
- end_commit: `8906f269ae7c69a5586f22cc586f89dc85b5ba55`
- commits_in_range: `1`

## Highlights

- Fix embedded WorkerPal backend metadata loading so it resolves `backend.toml` from `loadPushPalsConfig().configDir` instead of reconstructing `projectRoot/configs/backend.toml`.
- Preserve the strict fail-fast behavior for missing runtime backend config while making the embedded WorkerPal binary work correctly against arbitrary external repos.
- Add an explicit backend-config path helper so runtime config resolution is shared and testable.
- Regenerate the packaged CLI sandbox runtime snapshot so the embedded WorkerPal backend loader matches the source tree fix.
- Add regression coverage proving backend config resolution follows the effective runtime config directory rather than the target repo root.

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
- Tag and push: `git tag v1.0.21 && git push origin v1.0.21`.

