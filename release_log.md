# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.7`
- start_commit: `5d5d658c498c0b3b50332deb168b5cddde69fee1`
- end_commit: `521d4d17e31eeed54b8b166417413fd52fde4b54`
- commits_in_range: `3`

## Highlights

- Let OpenAI Codex WorkerPal jobs use the configured backend timeout instead of being capped by the shorter planning execution budget, preventing valid long-running work from being killed at 30 minutes.
- Harden WorkerPal validation and review-fix recovery paths: safer Bun test path formatting, clearer unchanged-branch review-fix guidance, and a SourceControlManager poll fix for stale `tempBranch` errors.
- Recover Docker-backed WorkerPal execution when the local `pushpals-worker-sandbox:latest` image disappears while the runtime is already running by rebuilding the local sandbox image before retrying warm startup.
- Stabilize Windows release validation by waiting out transient `EBUSY` temp-directory cleanup in RemoteBuddy tests instead of failing the full root test suite under load.

## Validation

- `bun test tests/workerpals.docker-executor.test.ts`
- `bun x --bun tsc --noEmit -p apps/workerpals/tsconfig.json`
- `bun run lint` completed with 2 pre-existing client warnings.
- `bun run cli:bundle`
- `bun test tests/remotebuddy.session-routing.test.ts tests/remotebuddy.task-dedupe.test.ts`
- `bun run test:root` completed successfully: 760 pass, 1 skip, 0 fail.
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
