# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.11`
- start_commit: `fc49858e45fa2b12165d36a1c1b5719d68149c53`
- end_commit: `fc49858e45fa2b12165d36a1c1b5719d68149c53`
- commits_in_range: `1`

## Highlights

- Force-enable LocalBuddy for interactive embedded CLI sessions so `pushpals` still starts correctly even when `localbuddy.enabled=false` in runtime config.
- Normalize discovered and configured Windows Git executables into `PATH` plus basename spawning so embedded SourceControlManager can reliably launch `git.exe` inside packaged runtime processes.
- Add targeted CLI/runtime regression coverage for the LocalBuddy bootstrap contract and Windows Git path normalization.

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
- Tag and push: `git tag v1.0.11 && git push origin v1.0.11`.
