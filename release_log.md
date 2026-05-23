# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.96`
- start_commit: `bd646503dfd6ced4dab1efb3b2867ed2f2818f7d`
- end_commit: `fe6aec25794ab3ef668e666e7c7ff91994106af8`
- commits_in_range: `3`

## Highlights

- Preserve Git trust config inside WorkerPal sandbox `HOME` so Docker-backed Codex workers can inspect mounted Linux CI worktrees after sandbox HOME/cache redirection.
- Retry the OpenAI Codex backend git-repository preflight briefly, with clearer diagnostics for transient worktree visibility/trust failures.
- Stabilize the WorkerPals Codex policy-violation E2E path by waiting for recycle deterministically and dumping worker/request diagnostics on unexpected payloads.
- Sync packaged CLI runtime assets so the published sandbox includes the WorkerPal Codex and sandbox HOME fixes.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `python tests/openai_codex_executor_streaming.test.py`
- `bun test tests/workerpals.sandbox-env.test.ts`
- `bun test ./tests/integration/workerpals.control-plane.e2e.ts --test-name-pattern "worker reports a codex policy violation"`
- `bun run test:workerpals:e2e`
- GitHub Actions CLI E2E on `fe6aec25794ab3ef668e666e7c7ff91994106af8`: Linux Packaged CLI E2E and Linux WorkerPals Control Plane E2E passed (`26330092293`).

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
