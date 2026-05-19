# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.86`
- start_commit: `22e29816c0a4db8ca751812e890425094661ea1e`
- end_commit: `b3aff604c307eaa7963c1941b36b9deb978d9c2a`
- commits_in_range: `1`

## Highlights

- Classify WorkerPal ValidationGate failures as task-scoped, outside-task-scope, or infrastructure-like so pre-existing repo failures no longer consume all auto-revision attempts for unrelated small tasks.
- Treat outside-task-scope required validation failures as publish blockers with direct diagnostics instead of repeatedly asking Codex to revise files it was not allowed to touch.
- Add actionable validation summaries that preserve the important error line for each failing command while avoiding noisy full-output dumps.
- Avoid rerunning long browser validation after an earlier infrastructure-like E2E failure, reducing repeated ten-minute stalls during auto-revision cycles.
- Inject the sandbox Expo port into `bun run web:e2e` style commands and normalize duplicate `bunx`/`bun x` validation commands.
- Improve autonomy ideation guidance so generated work targets behavior-owning implementation files instead of thin route wrappers when the vision calls for product-visible improvements.
- Skip Codex commit-message generation immediately when no Codex model is configured, keeping SourceControlManager publish flow deterministic in that configuration.
- Sync the packaged CLI runtime and sandbox assets so installed CLI users receive the updated WorkerPal validation and ideation behavior.

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
