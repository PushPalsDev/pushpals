# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.80`
- start_commit: `991b7bf8cf7644d7733588ab25514341ce39265c`
- end_commit: `3a68ee936334630cd922dc41b7da9949321e5e10`
- commits_in_range: `2`

## Highlights

- Add shared tool-run diagnostics so WorkerPal and server paths can classify tool failures, preserve retry guidance, and expose tool-run records through the control plane.
- Record WorkerPal tool failure diagnostics for Git, Codex, Bun, Docker, GitHub CLI, Node, shell, and discovered tools without forcing every tool into a fixed enum.
- Add `vision.md` testing criteria as a user-owned validation contract and include it in the generated starter vision document.
- Require WorkerPals to run repo-authored testing criteria before PR or revision publication, preserving repo-native commands such as `bun`, `npm`, `node`, `tsc`, `go`, `cargo`, and script-shell checks.
- Make failed required validation criteria a hard publish blocker while still surfacing repo or environment blockers with diagnostics.
- Improve autonomy vision processing with generic repo objective categories instead of repo-specific blueprints, keeping autonomous work aligned across arbitrary repositories.

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
