# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.33`
- start_commit: `576b63116eaba0d497ea5b582e3e8a8d80507edb`
- end_commit: `bae7d97f450d08c98e6a4346ef358ab92a655103`
- commits_in_range: `2`

## Highlights

- Fix WorkerPal Python executor startup failures on Windows by moving large base64 job payloads out of process argv and into short-lived payload files, preventing `ENAMETOOLONG: name too long, uv_spawn` before Codex can start.
- Apply the safe payload transport to the generic Python executor path and the specialized OpenHands path, covering OpenAI Codex, MiniSwe, and OpenHands wrapper launches.
- Keep shared Python wrapper compatibility with legacy positional payloads while adding `--payload-file` and `--payload-stdin` decoding support for future-safe transports.
- Tighten release package payload guard coverage so executable-mode external tool files are rejected before npm publish.
- Regenerate packaged CLI runtime assets so the npm CLI includes the WorkerPal payload transport helper and mirrored wrapper updates.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests\\workerpals.generic-python-executor.test.ts tests\\release-package-payload.test.ts`
- `python apps\\workerpals\\src\\backends\\openai_codex\\test_openai_codex_runtime_config.py`
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
- Docker-backed WorkerPal execution can use the first stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; the first affected job may fail as the canary that activates fallback.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
