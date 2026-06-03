# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.14`
- start_commit: `5873264a69877f14dcd2e376f86ee0fa4e5727c0`
- end_commit: `494af87ac2fcfe2751064ac2c29582bb30e38d6d`
- commits_in_range: `1`

## Highlights

- Fix OpenAI Codex WorkerPal timeout handling so the Python Codex wrapper times out before the TypeScript host kills it, preserving structured timeout salvage.
- Add host-side finalization grace for Python backend result emission while keeping the Codex child timeout below the execution budget.
- Keep the no-edit watchdog active on the recovery attempt so repeated no-edit runs fail clearly instead of reaching a SIGTERM cliff.
- Suppress host-level executor timeout chatter from the interactive CLI stream while preserving final job lifecycle lines.
- Sync the packaged CLI WorkerPal sandbox so embedded installs receive the same timeout-salvage behavior.

## Validation

- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`
- `python apps\workerpals\src\backends\openai_codex\test_openai_codex_runtime_config.py`
- `bun test tests\cli.runtime-bootstrap.test.ts --filter "formatSessionEventLine"`
- `bun test tests\workerpals.generic-python-executor.test.ts`
- `bun x tsc --noEmit --project apps\workerpals\tsconfig.json`
- `bun x tsc --noEmit --project packages\cli\runtime\sandbox\apps\workerpals\tsconfig.json`

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
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
