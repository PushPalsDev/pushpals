# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.37`
- start_commit: `e47fc72c05cc7ac629f9120979f4831ab4d38783`
- end_commit: `254ca106a6d5e12e3a5c8ce24386f05c9daba53b`
- commits_in_range: `1`

## Highlights

- Fix CLI shutdown cleanup on Windows by falling back to forced worktree deletion when `git worktree remove` hits `Filename too long`.
- Reuse the shared long-path worktree cleanup behavior for lingering WorkerPal worktrees and add regression coverage for the shutdown cleanup path.

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
- Tag and push: `git tag v1.0.37 && git push origin v1.0.37`.
