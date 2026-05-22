# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.94`
- start_commit: `099c52cd6b2faa8e73a979e37d122c75a1b32d5e`
- end_commit: `78ff960251da085c67ddb7ad4d2b01d6b098939d`
- commits_in_range: `4`

## Highlights

- Start the first RemoteBuddy autonomy tick shortly after runtime readiness, retry timed-out ideation once with a compact budget-aware prompt, and clear stale dispatch locks more aggressively on startup.
- Mask repo-local `.codex` sentinels before Codex CLI execution so WorkerPal ChatGPT auth can keep using the host Codex state directory.
- Treat WorkerPal planning scope metadata as review and planning hints instead of hard write boundaries; PR review remains the enforcement layer for relevance and safety.
- Avoid staging ignored runtime artifacts such as `outputs`, `workspace`, and `.codex` when WorkerPal creates `task.execute` commits.

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

- npm publication requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
