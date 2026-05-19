# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.85`
- start_commit: `2ca1be9ec5d0b3aeaadf843d10c85b2ee6d289a9`
- end_commit: `300da779bed9d46b60d64f9d90b6b062671e8c57`
- commits_in_range: `2`

## Highlights

- Split WorkerPal quality enforcement into explicit ScopeGate, ValidationGate, CriticGate, and PublishGate phases so validation, scope, AI review, and publish blockers can be configured and diagnosed independently.
- Give ValidationGate its own retry budget with three default auto-revision attempts for repo/user-required validation failures from `vision.md`.
- Run WorkerPal validation and executor subprocesses with writable sandbox HOME, Expo, XDG, and npm cache directories, avoiding Expo failures that try to write under `/root/.expo`.
- Preserve Codex authentication while redirecting sandbox HOME by keeping explicit or discovered `CODEX_HOME` outside the repo worktree.
- Add a longer browser/e2e validation timeout floor for commands such as `bun run web:e2e`, Playwright, Cypress, and Expo web startup while keeping normal unit/lint validation on the shorter configured timeout.
- Add clearer timeout diagnostics for ValidationGate failures and assign per-repo Expo/Metro default ports to reduce stale-server and worker contention during browser smoke validation.
- Sync the packaged CLI runtime and sandbox assets so installed CLI users receive the updated WorkerPal validation behavior.

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
