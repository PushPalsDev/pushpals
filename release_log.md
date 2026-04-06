# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.38`
- start_commit: `8b1a4d956f11c8475603f4882fb835094fddd2cb`
- end_commit: `0052ef4f8ea3638899dfe132f3a64fdfe0af13d7`
- commits_in_range: `1`

## Highlights

- Make the CLI npm publish workflow idempotent by detecting already-published versions before attempting `npm publish`.
- Keep release reruns green under npm immutable version rules by skipping duplicate package builds and publishes for the same tagged CLI version.

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
- Tag and push: `git tag v1.0.38 && git push origin v1.0.38`.
