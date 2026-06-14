# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.48`
- start_commit: `f86b9325094929c34a71440b8a0db912380a689e`
- end_commit: `43a1feb38b97a170a87ff8f09d23a7b3326cbe21`
- commits_in_range: `1`

## Highlights

- Resolve Bun from the CLI/runtime environment before direct WorkerPal validation launches `bun`, `bunx`, or toolchain preflight probes.
- Normalize Windows `Path`/`PATH` inside the writable validation sandbox and prepend the resolved Bun directory for child scripts.
- Return a structured validation failure when a validation executable cannot start instead of failing the entire job with an uncaught `uv_spawn 'bun'`.
- Add regression coverage for embedded Bun resolution, Windows path casing, browser smoke port injection, and missing-executable validation startup.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests/workerpals.sandbox-env.test.ts tests/workerpals.validation-command-safety.test.ts`
- `bun run test:root`
- `bun x tsc -p apps/workerpals/tsconfig.json --noEmit` *(blocked by pre-existing nullability errors in `apps/workerpals/src/workerpals_main.ts`)*
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
- Docker-backed WorkerPal execution can use a stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; if the replacement direct WorkerPal also cannot start Codex, that retry can still fail terminally and recycle the worker.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
