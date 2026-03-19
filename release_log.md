# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.14`
- start_commit: `e62fd410887503ec88b440dd668996dea4aba548`
- end_commit: `e62fd410887503ec88b440dd668996dea4aba548`
- commits_in_range: `1`

## Highlights

- Make embedded SourceControlManager resilient to Git resolution failures by retrying across Git executable candidates instead of hard-failing on one path.
- Prefer PATH-based Git invocation first for SCM startup/runtime operations, with absolute Git path fallback for cross-platform robustness.
- Add regression coverage proving SCM falls back to PATH Git when an absolute override cannot be spawned.

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
- Tag and push: `git tag v1.0.14 && git push origin v1.0.14`.
