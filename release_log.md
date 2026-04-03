# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.34`
- start_commit: `8d01b605606f0cc58b384c203500c5d04fb4864c`
- end_commit: `5aeaeea22bbd4bd548efba28ffe6d0f93998edc4`
- commits_in_range: `1`

## Highlights

- Harden WorkerPal Docker warm-container startup on Windows and Docker Desktop by validating that new worktrees are visible inside the long-lived warm container, recycling that container once when bind-mount propagation lags, and tightening startup self-check coverage around the real execution path.
- Remove duplicate `job_failed` session output when the server already accepted the worker failure hook, while preserving direct fallback emission when server-side persistence does not succeed.

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
- Tag and push: `git tag v1.0.34 && git push origin v1.0.34`.
