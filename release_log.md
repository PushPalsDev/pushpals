# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.23`
- start_commit: `9293f4e721983e72bf61edd3819c680008847a02`
- end_commit: `11f1182de1c4f58074043ea69ede35ea0cee88a5`
- commits_in_range: `2`

## Highlights

- Fix OpenAI Codex WorkerPal dirty-baseline accounting so pre-existing worktree changes are not misclassified as broad worker-created patches.
- Preserve the safety guard for genuinely broad or noisy small-task edits by counting new paths and same-path edits made after the job starts.
- Use bounded filesystem fingerprints for baseline paths so the fix does not add expensive per-path Git diff work on Windows.
- Add regression coverage for dirty baseline timeout handling and same-path baseline mutations.
- Update the `task.execute` integration harness to allow bounded diagnostics on executor results while still asserting the stable result contract.
- Ship the updated WorkerPal sandbox mirror in the packaged CLI runtime assets.

## Validation

- `bun run cli:bundle`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun test tests/integration/task.execute.test.ts`
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
- Active runtimes that were started from `v1.1.22` or earlier must be restarted after installing this release before WorkerPal jobs use the dirty-baseline fix.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
