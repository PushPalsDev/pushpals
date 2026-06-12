# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.36`
- start_commit: `325ad8f8810abb73955a5d759dcec9f93b2dd508`
- end_commit: `71da2b299d9be510e8be7fc47b014c58460ee80e`
- commits_in_range: `1`

## Highlights

- Make the OpenAI Codex no-edit watchdog command-aware so legitimate tool reads or shell commands get a bounded post-command patch window before recovery fires.
- Preserve no-edit protection for prose-only discovery loops and artifact-only diffs; the new grace applies only after observed Codex command/tool activity.
- Add regression coverage for command-backed discovery that patches after the old no-edit deadline, while retaining existing no-edit and transient-artifact watchdog coverage.
- Sync the packaged CLI runtime sandbox so installed `@pushpalsdev/cli` users receive the WorkerPal watchdog fix.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `python packages\\cli\\runtime\\sandbox\\apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
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
- The npm package still requires a working Bun runtime to launch the package entrypoint; PushPals does not vendor Bun or other external toolchains in the npm package.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; this release hardens the direct fallback payload handoff, but the original Docker stall is still treated as a worker-recycle event.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
