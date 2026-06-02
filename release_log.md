# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.11`
- start_commit: `8219622963c28654ea0f2070397a291e09e6ca96`
- end_commit: `9a647c50ca35d59a35faf6b6aeb6e33f290c294c`
- commits_in_range: `2`

## Highlights

- Reduce WorkerPal browser-validation convergence from the previous long-running multi-hour posture to a bounded human-scale repair window.
- Cap browser-validation Docker job timeouts at 20-45 minutes and report whether the timeout was capped or extended.
- Fail fast when review-fix or shell-wrapper runs leave no publishable code diff, instead of spending validation and critic time on empty or artifact-only patches.
- Filter dependency/runtime artifacts such as `node_modules`, `outputs`, `.worktrees`, and `.codex` out of publishable changed-path detection.
- Parallelize embedded runtime binary downloads with bounded concurrency while keeping tag marker writes, chmod, and cleanup sequential after successful downloads.
- Add sparse startup readiness breadcrumbs so delayed runtime startup explains whether it is waiting for LocalBuddy or the RemoteBuddy session consumer.
- Reduce CLI job-log noise while preserving meaningful WorkerPal phase, validation, quality, and publish progress.

## Validation

- `bun run cli:bundle`
- `bun run test:root` completed successfully: 778 pass, 1 skip, 0 fail.
- `git diff --check`
- `bun test tests/cli.runtime-bootstrap.test.ts --filter ensureRuntimeBinaries`
- `bun test tests/workerpals.docker-executor.test.ts --filter browser-validation`
- `bun test tests/workerpals.quality-gate-issues.test.ts --filter "browser validation"`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun x tsc --noEmit --project apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit --project packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- `bun run lint` completed with 2 pre-existing client warnings.

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
