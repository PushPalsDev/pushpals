# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.32`
- start_commit: `9357d9e367b9e708dad1b6285612faab64b9141a`
- end_commit: `f6c101e8da66d093aec1e5224e2617f23dae5b8e`
- commits_in_range: `1`

## Highlights

- Add a release-time npm package payload verifier that fails if `@pushpalsdev/cli` would ship external toolchain files such as Bun, Node, Git, Docker, Codex, UV, Python, real `node_modules`, virtualenvs, native libraries, or standalone executables.
- Wire the verifier into the npm publish workflow before `npm publish`, so a bad package payload is blocked before it reaches users.
- Add a GitHub release asset-name guard so direct release uploads stay limited to PushPals binaries, checksums, and signatures rather than accidental third-party tool artifacts.
- Document the release policy boundary: npm package payloads must not vendor external tools; PushPals-built standalone CLI/runtime release artifacts remain a separate supported distribution path.

## Validation

- `bun test tests/release-package-payload.test.ts`
- `bun run cli:bundle`
- `bun run cli:verify-package-payload`
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
- The npm package still requires a working Bun runtime to launch the package entrypoint; this release prevents vendored external tool files from entering the package, it does not remove the Bun runtime requirement for npm installs.
- Direct GitHub release binaries are PushPals-built standalone artifacts. Removing embedded Bun runtime from those standalone artifacts would require a separate runtime distribution redesign.
- Active runtimes that were started from an older release must be restarted after installing this release before new startup or packaged-runtime behavior takes effect.
- Docker-backed WorkerPal execution can use the first stalled Docker Codex startup as the signal to switch future WorkerPal spawns to direct isolated-worktree execution; the first affected job may fail as the canary that activates fallback.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- User-local `runtime/configs/local.toml` overrides can preserve older runtime defaults during manual smoke testing; use `pushpals --clear` or remove the local override to pick up new packaged defaults.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
