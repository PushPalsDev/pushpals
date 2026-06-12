# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.34`
- start_commit: `62265128bdc7ecb50b441231aff3691db14c8d95`
- end_commit: `663955b73d9ebdf5faad24ba470b36aa14d40a80`
- commits_in_range: `1`

## Highlights

- Fix the `v1.1.33` npm publish failure by allowing expected PushPals-generated JavaScript payload artifacts that npm reports with executable file mode on Linux.
- Preserve the package payload guard against vendored external toolchains, native libraries, virtualenvs, `node_modules`, and executable files outside the known PushPals CLI/runtime JS entrypoints.
- Add release guard coverage for the allowed generated JS artifacts so future publish checks do not regress into false positives.

## Validation

- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
- `bun test tests\\release-package-payload.test.ts`
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
