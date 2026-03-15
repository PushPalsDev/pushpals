# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.10`
- start_commit: `e65621e9f7a782e976ff864c0a183d3d13397620`
- end_commit: `a60ed955b53f5d0f9cf2a88a7e5b0b604470bdc5`
- commits_in_range: `4`

## Highlights

- Add timestamped CLI bootstrap logs and clearer runtime startup progress so embedded service delays are visible during startup.
- Apply LocalBuddy live config changes dynamically across server and VS Code supervisor flows, including preflight validation before live enable.
- Reduce the default local WorkerPal quality auto-revision budget from `4` to `1` for faster review loops and lower local churn.
- Support arbitrary git repos in the VS Code client by using the installed `pushpals` CLI runtime path, make client state worktree-safe, and expire stale connected client presence records.

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
- Tag and push: `git tag v1.0.10 && git push origin v1.0.10`.
