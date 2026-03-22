# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.15`
- start_commit: `58328498136a55998422f097e8fe2364ca320413`
- end_commit: `58328498136a55998422f097e8fe2364ca320413`
- commits_in_range: `1`

## Highlights

- Harden SourceControlManager git command execution on Windows by expanding executable candidates, adding a `cmd.exe` fallback path, and surfacing aggregated spawn diagnostics.
- Add a blocking CLI startup precheck that verifies the configured PushPals branch exists on `origin`, and fail fast when it is missing.
- Make CLI git precheck non-interactive (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`) to avoid startup hangs during remote validation.
- Add a clear startup alias log line (`pushpals log: ...`) pointing to the runtime services log for easier troubleshooting.
- Extend CLI invocation logging tests for missing-branch fail-fast behavior and environment-dependent stderr output handling.

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
- Tag and push: `git tag v1.0.15 && git push origin v1.0.15`.
