# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.35`
- start_commit: `2ec07ce6e1e80e8e7901f84cb87d6d4e2678ae0d`
- end_commit: `b78c5a5fc72942cd83dc94e0409d3016ef27c3e0`
- commits_in_range: `2`

## Highlights

- Recover OpenAI Codex WorkerPal startup stalls by detecting runs that emit only startup events, recycling the affected worker, and retrying once with fallback-model guidance before marking the job terminal.
- Harden Python executor payload decoding so Docker and direct WorkerPal recovery paths accept normal base64, unpadded base64, URL-safe base64, raw JSON recovery payloads, and positional payload-file handoffs.
- Add focused regression coverage for Codex startup-stall recovery and payload transport variants so direct fallback workers do not fail jobs with `Incorrect padding`.
- Sync the packaged CLI runtime sandbox so installed `@pushpalsdev/cli` users receive the WorkerPal fixes.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `python apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
- `bun test tests\\workerpals.generic-python-executor.test.ts tests\\workerpals.task-execute-schema.test.ts tests\\remotebuddy.worker-spawn-command.test.ts tests\\remotebuddy.worker-autoscale.test.ts`
- `bun test tests\\release-windows-runtime-smoke.test.ts`
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
