# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.79`
- start_commit: `197fc4376941b7f7312214d70c53370c637f5d95`
- end_commit: `f4939f4bc92b6cb0e7c16133c036eee80c05cf7c`
- commits_in_range: `1`

## Highlights

- Fix RemoteBuddy autonomy liveness when an orphaned same-session dispatch lock blocks the next idea-generation tick.
- Add bounded same-session stale-lock takeover for autonomy dispatch while preserving cross-session lock protection.
- Make `lock_not_acquired` heartbeat diagnostics include the server denial reason so future stalls are visible in logs.
- Prefer the concrete Bun launcher from `PUSHPALS_BUN_BIN` when resolving default Codex CLI commands, avoiding stale service PATH shims.
- Add regression coverage for stale autonomy lock replacement, Codex launcher resolution, and tick lock-acquire payloads.

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
