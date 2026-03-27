# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.27`
- start_commit: `7afbb45dd3b6a95527483275236ce4d917866cfc`
- end_commit: `7afbb45dd3b6a95527483275236ce4d917866cfc`
- commits_in_range: `1`

## Highlights

- Fix the GitHub Actions release workflow so optional signing gates no longer reference `secrets.*` directly in `if:` expressions, which GitHub rejects during workflow parsing.
- Move release signing inputs to job-level environment variables and gate Windows, macOS, and Linux signing steps through `env.*` checks instead.
- Preserve the existing behavior where missing signing credentials simply skip signing while still allowing the release workflow to publish unsigned artifacts successfully.

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
- Tag and push: `git tag v1.0.27 && git push origin v1.0.27`.

