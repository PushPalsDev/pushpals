# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.77`
- start_commit: `2d8603c9dc4928d7a49c3bfbdde35c778c71aae6`
- end_commit: `e02b92ec81c729227a3acd727b41d2a7cbd807f4`
- commits_in_range: `1`

## Highlights

- Migrate stale embedded runtime `local.toml` Codex defaults from `gpt-5.4`/`high` to `gpt-5.5`/`xhigh` during CLI runtime preparation.
- Preserve custom non-legacy Codex model and reasoning overrides while updating only exact legacy default values.
- Add regression coverage for stale generated runtime config migration and custom override preservation.
- Verify the CLI bootstrap, shared config, and packaged CLI end-to-end suites after the migration fix.

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
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal task execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
