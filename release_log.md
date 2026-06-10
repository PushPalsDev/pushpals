# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.31`
- start_commit: `4e934d31293bc0c32da399426383411f81d23447`
- end_commit: `ecbba5baae51af23a4fb1b4b2f4883c85fbd879c`
- commits_in_range: `1`

## Highlights

- Resolve Windows Bun npm/nvm shims to the underlying `node_modules/bun/bin/bun.exe` before probing or launching the packaged CLI.
- Preserve the `v1.1.30` Bun probe timeout while avoiding the false “Bun runtime is required” failure when `bun` is available through `bun.cmd` or extensionless Windows shims.
- Keep the shell fallback only for unresolved Windows Bun commands; resolved Bun executables now run directly under the timeout/watchdog path.
- Add regression coverage that the package shim knows about Windows `where.exe` Bun discovery and shim-target resolution.

## Validation

- `bun run cli:bundle`
- `node --check packages/cli/bin/pushpals.cjs`
- `node packages/cli/bin/pushpals.cjs -h`
- `bun test tests/cli.runtime-bootstrap.test.ts`
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
- `v1.1.30` npm installs can incorrectly report that Bun is missing on Windows when Bun is exposed through npm/nvm shims; install `v1.1.31` or use direct binary assets.
- Active runtimes that were started from `v1.1.29` or earlier must be restarted after installing this release before the startup watchdog and fresh-binary WorkerPal prewarm delay take effect.
- Docker-backed WorkerPal execution still uses the first stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; the first affected job may fail as the canary that activates fallback.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
