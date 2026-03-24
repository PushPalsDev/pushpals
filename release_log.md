# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.24`
- start_commit: `e09ed19c6e0bf8cd1cab3447f91b0baab8db068a`
- end_commit: `ed7666d4445534207a92200f7b357abba79035a5`
- commits_in_range: `1`

## Highlights

- Gracefully stop CLI auto-started runtime services on exit so WorkerPal Docker cleanup can finish instead of being force-killed immediately.
- Wait for per-job worktree paths to become visible inside warm Docker containers before running `docker exec -w ...`, and retry transient `chdir to cwd` startup races instead of failing jobs with exit `126`.
- Downgrade unsupported Codex `reasoning_effort = "xhigh"` requests to `high` for `gpt-5.4` and related `codex-1p*` model paths.
- Align repo, packaged runtime, and packaged sandbox config defaults to `reasoning_effort = "high"` so installed CLI behavior matches the source tree.
- Add regression coverage for Docker worktree visibility races and Codex reasoning-effort normalization.

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
- Tag and push: `git tag v1.0.24 && git push origin v1.0.24`.

