# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.73`
- start_commit: `f341f6d7b8ac605a6e5771dbf3e23e68dd49034e`
- end_commit: `4741080e356cb044135fc44d121c860cae15ac48`
- commits_in_range: `1`

## Highlights

- Suppress autonomy-origin RemoteBuddy, WorkerPal, and SourceControlManager chatter from the interactive CLI session stream while preserving user-directed assistant messages and clarification prompts.
- Carry autonomy origin metadata through server queues, completions, protocol schemas, packaged runtime assets, and client visibility filters so web, VS Code, and CLI timelines stay consistent.
- Add a packaged CLI session-stream end-to-end regression that starts a real server, connects the CLI, fakes RemoteBuddy and WorkerPal presence, injects hidden autonomy events, and verifies only user-facing events reach stdout.

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
