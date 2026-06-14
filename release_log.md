# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.44`
- start_commit: `23e99af1c224dbd9522197369448bc652f49e8a0`
- end_commit: `166d2876b1ecf1835824cf274f4cf2438403ebae`
- commits_in_range: `1`

## Highlights

- Give WorkerPal Codex no-edit recovery one same-model restart when the patch-first retry stalls before its first response, preserving the model that already made tool progress before falling back.
- Keep the plain repeated startup-stall path terminal, while making the no-edit recovery ladder less brittle for transient Codex startup stalls in background autonomy jobs.
- Add source and packaged-runtime regression coverage for the real sequence: tool progress without a patch, patch-first startup stall, then same-model recovery to a publishable edit.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `python packages/cli/runtime/sandbox/apps/workerpals/src/backends/openai_codex/test_openai_codex_runtime_config.py`
- `bun test tests/workerpals.generic-python-executor.test.ts`
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
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; this release preserves recovery budget for background jobs, but the original Docker stall is still treated as a worker-recycle event.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
