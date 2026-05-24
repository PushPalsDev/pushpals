# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.0`
- start_commit: `8fd050651899e4fc6276f20fec07cd65c933a167`
- end_commit: `c5074100aef593a750db9f3322ed5a6c368f838e`
- commits_in_range: `1`

## Highlights

- Adopt the release numbering policy that patch releases roll the minor version after `.99`, so future releases move from `vX.Y.99` to `vX.(Y+1).0`.
- Document the forward-only correction path for already-published patch-above-99 releases: keep the published version intact and cut the next policy-correct minor release.
- Move `latest` forward to `v1.1.0` after the already-published `v1.0.100` release.
- Confirm `bun run cli:bundle` produced no additional packaged runtime asset changes for this documentation-only release.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
